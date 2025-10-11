import amqp, { Channel } from "amqplib";
import { ENV } from "./environments";

let channel: Channel | null = null;

export enum RabbitMQQueues {
  VIDEO_PROCESSING = "video_processing",
}

async function connectWithRetry(
  retries = 10,
  delay = 10000
): Promise<amqp.ChannelModel> {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await amqp.connect(
        `amqp://${ENV.RABBITMQ_DEFAULT_USER}:${ENV.RABBITMQ_DEFAULT_PASS}@rabbitmq:5672`,
        {
          // Increase heartbeat interval to 60 seconds for long-running processes
          heartbeat: 60,
          // Connection timeout settings
          connectionTimeout: 30000,
          authenticationTimeout: 30000,
          // Keep connection alive during long operations
          handshakeTimeout: 30000,
        }
      );
      console.log("CONNECTED to RabbitMQ");
      return conn;
    } catch (err) {
      console.warn(
        `RabbitMQ NOT READY, retrying in ${delay}ms... (${i + 1}/${retries})`
      );
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw new Error("FAILED to connect to RabbitMQ after multiple attempts");
}

/**
 * Initialize RabbitMQ connection and channel
 */
export const initRabbitMQ = async (): Promise<void> => {
  try {
    const connection = await connectWithRetry();

    // Add connection error handlers
    connection.on("error", (err) => {
      console.error("RabbitMQ connection error:", err.message);
      // Set channel to null so we know we need to reconnect
      channel = null;
    });

    connection.on("close", () => {
      console.warn("RabbitMQ connection closed. Attempting to reconnect...");
      channel = null;
      // Attempt to reconnect after a delay
      setTimeout(() => {
        initRabbitMQ().catch((err) => {
          console.error("Failed to reconnect to RabbitMQ:", err.message);
        });
      }, 5000);
    });

    channel = await connection.createChannel();

    // Add channel error handlers
    channel.on("error", (err) => {
      console.error("RabbitMQ CHANNEL ERROR:", err.message);
    });

    channel.on("close", () => {
      console.warn("RabbitMQ channel closed");
    });

    console.log("RabbitMQ CONNECTED successfully");

    // Start video processing worker
    if (channel) {
      const { startVideoProcessingWorker } = await import("./videoProcessor");
      await startVideoProcessingWorker(channel);
    }
  } catch (error) {
    console.error("Failed to connect to RabbitMQ:", error);
    throw error;
  }
};

/**
 * Get the RabbitMQ channel
 */
export const getChannel = (): Channel | null => {
  return channel;
};

/**
 * Publish a message to a RabbitMQ queue
 */
export const publishToQueue = async (
  queueName: string,
  message: Record<string, any>
): Promise<void> => {
  if (!channel) {
    console.error(
      "RabbitMQ channel is NOT INITIALIZED. Attempting to reconnect..."
    );
    // Try to reconnect
    await initRabbitMQ();
    if (!channel) {
      throw new Error(
        "RabbitMQ channel is not available after reconnection attempt"
      );
    }
  }

  try {
    await channel.assertQueue(queueName, { durable: true });
    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(message)), {
      persistent: true,
    });
  } catch (error) {
    console.error("Failed to publish message to RabbitMQ:", error);
    // Set channel to null to trigger reconnection on next attempt
    channel = null;
    throw error;
  }
};

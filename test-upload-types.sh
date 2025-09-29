#!/bin/bash

# Test script for the new upload type feature
echo "🧪 Testing Upload Type Feature"
echo "================================"

# Test 1: Create TUS upload session (100MB limit)
echo "📝 Test 1: Creating TUS upload session (100MB limit)..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "test-video.mp4",
    "filesize": 10485760,
    "type": "tus",
    "uploadToS3": true
  }' | jq '.'

echo ""
echo "📝 Test 2: Creating Direct upload session (200MB limit)..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "test-video.mp4",
    "filesize": 10485760,
    "type": "direct",
    "uploadToS3": false
  }' | jq '.'

echo ""
echo "📝 Test 3: Test validation - invalid type..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "test-video.mp4",
    "filesize": 10485760,
    "type": "invalid"
  }' | jq '.'

echo ""
echo "📝 Test 4: Test default type (should be tus)..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "test-video.mp4",
    "filesize": 10485760
  }' | jq '.'

echo ""
echo "📝 Test 5: Test direct upload size limit (should accept 200MB file)..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "large-video.mp4",
    "filesize": 209715200,
    "type": "direct"
  }' | jq '.'

echo ""
echo "📝 Test 6: Test direct upload size limit exceeded (should reject 250MB file)..."
curl -X POST http://localhost:8001/api/v1/video/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "filename": "huge-video.mp4",
    "filesize": 262144000,
    "type": "direct"
  }' | jq '.'

echo ""
echo "✅ Test script completed!"
echo "Note: Replace 'your-api-key' with actual API key and ensure server is running on port 8001"
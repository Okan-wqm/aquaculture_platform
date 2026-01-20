#!/bin/bash

# Login to get token
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation{login(input:{email:\"okan@suderra.com\",password:\"Admin123!\"}){accessToken}}"}')

echo "Login response: $LOGIN_RESPONSE"

# x402 Testing Guide

Testing the x402 payment flow with the Venice x402 Client SDK.

## Prerequisites

- Node.js 18+
- A wallet with USDC on Base mainnet (for top-ups)
- Venice server running locally (for local testing)

## Setup

```bash
npm install @venice-ai/x402-client
```

Create a `.env`:

```bash
# ⚠️ Use a dedicated test wallet!
WALLET_KEY=0x...your_private_key...
```

## Test Flows

### 1. Check Balance

```typescript
import { VeniceClient } from '@venice-ai/x402-client'

const venice = new VeniceClient(process.env.WALLET_KEY!, {
  apiUrl: 'http://localhost:4000', // or https://api.venice.ai
})

const balance = await venice.getBalance()
console.log('Balance:', balance.data.balanceUsd, 'USD')
```

### 2. Top Up (Transfers Real USDC!)

```typescript
await venice.topUp(1) // $1 minimum
console.log('New balance:', venice.balance)
```

### 3. Chat Completion

```typescript
const response = await venice.chat({
  model: 'llama-3.3-70b',
  messages: [{ role: 'user', content: 'Hello!' }],
})
console.log(response.choices[0].message.content)
console.log('Remaining:', venice.balance)
```

### 4. Other Endpoints

```typescript
// Embeddings
const embed = await venice.embeddings({
  model: 'text-embedding-ada-002',
  input: 'test',
})

// Images
const image = await venice.images.generate({
  model: 'fluently-xl',
  prompt: 'a sunset',
})

// Video
const videoUrl = await venice.video.generate({
  model: 'wan-2.6-text-to-video',
  prompt: 'A cat walking',
  duration: '5s',
  aspect_ratio: '16:9',
})
```

## Verification Checklist

- [ ] `getBalance()` returns correct data
- [ ] `topUp()` transfers USDC and credits account
- [ ] Chat completions work
- [ ] Embeddings work
- [ ] Image generation works
- [ ] Balance decreases after each request
- [ ] DIEM stakers can use API without USDC top-up

## Troubleshooting

**INSUFFICIENT_BALANCE**: Top up first with `venice.topUp(1)`

**Invalid signature**: Check `WALLET_KEY` is valid (0x + 64 hex chars)

**Connection failed**: Ensure server is running, check `apiUrl`


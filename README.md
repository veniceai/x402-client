# Venice x402 Client

Pay-per-request AI inference using your crypto wallet. No API keys needed.

## Install

npm install @venice-ai/x402-client## Usage

import { VeniceClient } from '@venice-ai/x402-client'

const venice = new VeniceClient({ privateKey: process.env.WALLET_KEY })

const response = await venice.chat({
  model: 'llama-3.3-70b',
  messages: [{ role: 'user', content: 'Hello!' }]
})

console.log(response.choices[0].message.content)
console.log(`Balance: $${venice.balance}`)## How it Works

1. Your wallet signs each request (proves identity)
2. Venice checks your credit balance
3. If low, returns 402 with payment requirements
4. SDK handles USDC payment automatically
5. Credits added, request retries

## Networks

- **Base Mainnet** (Chain ID: 8453)
- **USDC** for payments

## License

MIT

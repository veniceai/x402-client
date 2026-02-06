import { Wallet } from 'ethers'
import { SiweMessage } from 'siwe'

export interface VeniceClientOptions {
  /** API endpoint (default: https://api.venice.ai) */
  apiUrl?: string
  /** Auto top-up settings */
  autoTopUp?: {
    enabled: boolean
    amount: number
    threshold: number
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  model: string
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

export interface ChatResponse {
  id: string
  choices: Array<{
    index: number
    message: ChatMessage
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class VeniceClient {
  private wallet: Wallet
  private apiUrl: string
  private autoTopUp?: VeniceClientOptions['autoTopUp']
  private _balance: number = 0

  constructor(privateKey: string, options: VeniceClientOptions = {}) {
    this.wallet = new Wallet(privateKey)
    this.apiUrl = options.apiUrl || 'https://api.venice.ai'
    this.autoTopUp = options.autoTopUp
  }

  /** Current credit balance in USD */
  get balance(): number {
    return this._balance
  }

  /** Wallet address */
  get address(): string {
    return this.wallet.address
  }

  /**
   * Chat completion (OpenAI-compatible)
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const authHeader = await this.createSignInHeader()

    const response = await fetch(`${this.apiUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sign-In-With-X': authHeader,
      },
      body: JSON.stringify(params),
    })

    // Handle 402 - payment required
    if (response.status === 402) {
      const data = await response.json()

      // Auto top-up if enabled
      if (this.autoTopUp?.enabled) {
        const amount = this.autoTopUp.amount || data.suggestedTopUpUsd || 10
        await this.topUp(amount)
        return this.chat(params) // Retry
      }

      throw new VeniceError('INSUFFICIENT_BALANCE', 'Insufficient balance', {
        currentBalance: data.currentBalanceUsd,
        suggestedAmount: data.suggestedTopUpUsd,
      })
    }

    if (!response.ok) {
      const data = await response.json()
      throw new VeniceError('API_ERROR', data.error || 'Request failed', {
        status: response.status,
      })
    }

    // Update balance from header
    const balanceHeader = response.headers.get('X-Balance-Remaining')
    if (balanceHeader) {
      this._balance = parseFloat(balanceHeader)
    }

    return response.json()
  }

  /**
   * Top up balance with USDC
   */
  async topUp(amountUsd: number): Promise<void> {
    // Step 1: Get payment requirements
    const reqResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (reqResponse.status !== 402) {
      throw new VeniceError('TOP_UP_ERROR', 'Failed to get payment requirements')
    }

    const requirements = await reqResponse.json()

    // Step 2: Create payment header using x402 protocol
    const paymentHeader = await this.createPaymentHeader(requirements, amountUsd)

    // Step 3: Submit payment
    const payResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-402-Payment': paymentHeader,
      },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (!payResponse.ok) {
      const data = await payResponse.json()
      throw new VeniceError('TOP_UP_FAILED', data.error || 'Top-up failed')
    }

    const result = await payResponse.json()
    this._balance = result.data?.newBalance || this._balance + amountUsd
  }

  /**
   * Create Sign-in-with-X header
   */
  private async createSignInHeader(): Promise<string> {
    const now = new Date()
    const expirationTime = new Date(now.getTime() + 10 * 60 * 1000) // 10 min

    const message = new SiweMessage({
      domain: new URL(this.apiUrl).host,
      address: this.wallet.address,
      statement: 'Sign in to Venice API',
      uri: this.apiUrl,
      version: '1',
      chainId: 8453, // Base mainnet
      nonce: Math.random().toString(36).substring(2, 15),
      issuedAt: now.toISOString(),
      expirationTime: expirationTime.toISOString(),
    })

    const messageString = message.prepareMessage()
    const signature = await this.wallet.signMessage(messageString)

    const payload = {
      address: this.wallet.address,
      message: messageString,
      signature,
      timestamp: now.getTime(),
      chainId: 8453,
    }

    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  /**
   * Create x402 payment header
   */
  private async createPaymentHeader(requirements: any, amountUsd: number): Promise<string> {
    // Dynamic import to avoid bundling x402 if not used
    const { createPaymentHeader, createSigner } = await import('x402/client')

    const signer = await createSigner('base', this.wallet.privateKey as `0x${string}`)

    const paymentRequirements = {
      scheme: 'exact' as const,
      network: 'base' as const,
      asset: requirements.paymentInfo?.tokenAddress || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: String(Math.floor(amountUsd * 1e6)), // USDC has 6 decimals
      payTo: requirements.paymentInfo?.receiverWallet,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    }

    return createPaymentHeader(signer, paymentRequirements)
  }
}

export class VeniceError extends Error {
  code: string
  details?: Record<string, any>

  constructor(code: string, message: string, details?: Record<string, any>) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'VeniceError'
  }
}


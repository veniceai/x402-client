import { Wallet } from 'ethers'
import { SiweMessage } from 'siwe'

// =============================================================================
// Types
// =============================================================================

export interface VeniceClientOptions {
  apiUrl?: string
  autoTopUp?: {
    enabled: boolean
    amount: number
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

// =============================================================================
// VeniceSigner - Core auth primitive
// =============================================================================

export class VeniceSigner {
  private wallet: Wallet
  private domain: string

  constructor(privateKey: string, apiUrl: string = 'https://api.venice.ai') {
    this.wallet = new Wallet(privateKey)
    this.domain = new URL(apiUrl).host
  }

  get address(): string {
    return this.wallet.address
  }

  get privateKey(): string {
    return this.wallet.privateKey
  }

  /** Create X-Sign-In-With-X header */
  async signIn(): Promise<string> {
    const now = new Date()

    const message = new SiweMessage({
      domain: this.domain,
      address: this.wallet.address,
      statement: 'Sign in to Venice API',
      uri: `https://${this.domain}`,
      version: '1',
      chainId: 8453,
      nonce: Math.random().toString(36).substring(2, 15),
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    })

    const messageString = message.prepareMessage()
    const signature = await this.wallet.signMessage(messageString)

    return Buffer.from(JSON.stringify({
      address: this.wallet.address,
      message: messageString,
      signature,
      timestamp: now.getTime(),
      chainId: 8453,
    })).toString('base64')
  }

  /** Create X-402-Payment header */
  async signPayment(requirements: {
    asset: string
    amount: string
    payTo: string
  }): Promise<string> {
    const { createPaymentHeader } = await import('x402/client')
    const { createSigner } = await import('x402/types')
    const signer = await createSigner('base', this.wallet.privateKey as `0x${string}`)

    return createPaymentHeader(signer, 1, {
      scheme: 'exact',
      network: 'base',
      asset: requirements.asset,
      maxAmountRequired: requirements.amount,
      payTo: requirements.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
      resource: '',
      description: 'Venice x402 payment',
      mimeType: 'application/json',
      outputSchema: undefined,
    })
  }
}

// =============================================================================
// createAuthFetch - For OpenAI-compatible tools
// =============================================================================

export function createAuthFetch(
  privateKey: string,
  options: { apiUrl?: string } = {}
): typeof fetch {
  const signer = new VeniceSigner(privateKey, options.apiUrl)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set('X-Sign-In-With-X', await signer.signIn())

    return fetch(input, { ...init, headers })
  }
}

// =============================================================================
// VeniceClient - High-level API
// =============================================================================

export class VeniceClient {
  private apiUrl: string
  private autoTopUp?: VeniceClientOptions['autoTopUp']
  private _balance: number = 0

  public readonly signer: VeniceSigner
  public readonly fetch: typeof fetch

  constructor(privateKey: string, options: VeniceClientOptions = {}) {
    this.apiUrl = options.apiUrl || 'https://api.venice.ai'
    this.autoTopUp = options.autoTopUp
    this.signer = new VeniceSigner(privateKey, this.apiUrl)
    this.fetch = createAuthFetch(privateKey, { apiUrl: this.apiUrl })
  }

  get balance(): number {
    return this._balance
  }

  get address(): string {
    return this.signer.address
  }

  /** Chat completion */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.fetch(`${this.apiUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })

    if (response.status === 402) {
      if (this.autoTopUp?.enabled) {
        await this.topUp(this.autoTopUp.amount || 10)
        return this.chat(params)
      }

      const data = await response.json()
      throw new VeniceError('INSUFFICIENT_BALANCE', 'Insufficient balance', {
        currentBalance: data.currentBalanceUsd,
        suggestedAmount: data.suggestedTopUpUsd,
      })
    }

    if (!response.ok) {
      const data = await response.json()
      throw new VeniceError('API_ERROR', data.error || 'Request failed', { status: response.status })
    }

    const balanceHeader = response.headers.get('X-Balance-Remaining')
    if (balanceHeader) this._balance = parseFloat(balanceHeader)

    return response.json()
  }

  /** Top up balance with USDC */
  async topUp(amountUsd: number): Promise<void> {
    // Get payment requirements
    const reqResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (reqResponse.status !== 402) {
      throw new VeniceError('TOP_UP_ERROR', 'Failed to get payment requirements')
    }

    const requirements = await reqResponse.json()

    // Create and submit payment
    const paymentHeader = await this.signer.signPayment({
      asset: requirements.paymentInfo?.tokenAddress || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: String(Math.floor(amountUsd * 1e6)),
      payTo: requirements.paymentInfo?.receiverWallet,
    })

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
}

// =============================================================================
// Error
// =============================================================================

export class VeniceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'VeniceError'
  }
}

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

// Chat types
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

// Models types
export interface Model {
  id: string
  object: string
  created: number
  owned_by: string
}

export interface ModelsResponse {
  object: string
  data: Model[]
}

// Embeddings types
export interface EmbeddingsParams {
  model: string
  input: string | string[]
}

export interface EmbeddingsResponse {
  object: string
  data: Array<{
    object: string
    embedding: number[]
    index: number
  }>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

// Image types
export interface ImageGenerateParams {
  model: string
  prompt: string
  width?: number
  height?: number
  n?: number
  style_preset?: string
}

export interface ImageResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
  }>
}

// Audio types
export interface SpeechParams {
  model: string
  input: string
  voice: string
  response_format?: 'mp3' | 'wav' | 'opus' | 'flac'
  speed?: number
}

export interface TranscribeParams {
  model: string
  file: Blob | Buffer
  language?: string
  response_format?: 'json' | 'text' | 'srt' | 'vtt'
}

export interface TranscribeResponse {
  text: string
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

  // Sub-clients for namespaced APIs
  public readonly images: ImagesAPI
  public readonly audio: AudioAPI

  constructor(privateKey: string, options: VeniceClientOptions = {}) {
    this.apiUrl = options.apiUrl || 'https://api.venice.ai'
    this.autoTopUp = options.autoTopUp
    this.signer = new VeniceSigner(privateKey, this.apiUrl)
    this.fetch = createAuthFetch(privateKey, { apiUrl: this.apiUrl })

    // Initialize sub-clients
    this.images = new ImagesAPI(this)
    this.audio = new AudioAPI(this)
  }

  get balance(): number {
    return this._balance
  }

  get address(): string {
    return this.signer.address
  }

  /** Internal request helper with 402 handling */
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (response.status === 402) {
      if (this.autoTopUp?.enabled) {
        await this.topUp(this.autoTopUp.amount || 10)
        return this.request(path, options)
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

  /** List available models */
  async models(): Promise<ModelsResponse> {
    return this.request('/api/v1/models')
  }

  /** Chat completion */
  async chat(params: ChatParams): Promise<ChatResponse> {
    return this.request('/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Create embeddings */
  async embeddings(params: EmbeddingsParams): Promise<EmbeddingsResponse> {
    return this.request('/api/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }

  /** Top up balance with USDC */
  async topUp(amountUsd: number): Promise<void> {
    const reqResponse = await fetch(`${this.apiUrl}/api/v1/x402/top-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountUsd }),
    })

    if (reqResponse.status !== 402) {
      throw new VeniceError('TOP_UP_ERROR', 'Failed to get payment requirements')
    }

    const requirements = await reqResponse.json()

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
// ImagesAPI - Image generation
// =============================================================================

class ImagesAPI {
  constructor(private client: VeniceClient) {}

  /** Generate images from a prompt */
  async generate(params: ImageGenerateParams): Promise<ImageResponse> {
    return this.client.request('/api/v1/image/generate', {
      method: 'POST',
      body: JSON.stringify(params),
    })
  }
}

// =============================================================================
// AudioAPI - Speech and transcription
// =============================================================================

class AudioAPI {
  constructor(private client: VeniceClient) {}

  /** Generate speech from text */
  async speech(params: SpeechParams): Promise<Blob> {
    const response = await this.client.fetch(
      `${(this.client as any).apiUrl}/api/v1/audio/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    )

    if (!response.ok) {
      const data = await response.json()
      throw new VeniceError('API_ERROR', data.error || 'Speech generation failed')
    }

    return response.blob()
  }

  /** Transcribe audio to text */
  async transcribe(params: TranscribeParams): Promise<TranscribeResponse> {
    const formData = new FormData()
    formData.append('model', params.model)
    formData.append('file', params.file as Blob)
    if (params.language) formData.append('language', params.language)
    if (params.response_format) formData.append('response_format', params.response_format)

    const response = await this.client.fetch(
      `${(this.client as any).apiUrl}/api/v1/audio/asr`,
      {
        method: 'POST',
        body: formData,
      }
    )

    if (!response.ok) {
      const data = await response.json()
      throw new VeniceError('API_ERROR', data.error || 'Transcription failed')
    }

    return response.json()
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

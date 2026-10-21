export type PeerStatus = 'in progress' | 'done'

/** One other live session in the same project folder, as this session last saw it. */
export type Peer = {
  sessionId: string
  label: string
  activity: string
  status: PeerStatus
  /** When that session last wrote its ledger file, in epoch ms. */
  heartbeatAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'collision-guard': { peers: Peer[]; isHidden: boolean }
  }
}

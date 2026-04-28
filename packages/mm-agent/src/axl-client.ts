// Minimal HTTP client for the local AXL node. SPEC §4.1, §5.0.
//
// AXL has no push primitive — recv() polls /recv and returns null if the
// queue is empty (HTTP 204). The MM Agent's main loop drives the cadence.

export interface AxlIncoming {
  /** Hex-encoded ed25519 sender identity. NOTE: this is a *prefix* of the
   *  full pubkey followed by `ff…` padding (Yggdrasil tree-id), not the raw
   *  key — see memory `axl_transport_quirks.md`. Never compare with `===`. */
  fromPeerId: string;
  body: Buffer;
}

export interface Topology {
  ourIpv6: string;
  ourPublicKey: string;
  peers: Array<{
    publicKey: string;
    up: boolean;
    inbound: boolean;
  }>;
}

export class AxlClient {
  constructor(private readonly baseUrl: string) {}

  async topology(): Promise<Topology> {
    const res = await fetch(`${this.baseUrl}/topology`);
    if (!res.ok) throw new Error(`/topology ${res.status}`);
    const j = (await res.json()) as {
      our_ipv6: string;
      our_public_key: string;
      peers?: Array<{ public_key: string; up: boolean; inbound: boolean }>;
    };
    return {
      ourIpv6: j.our_ipv6,
      ourPublicKey: j.our_public_key,
      peers: (j.peers ?? []).map((p) => ({
        publicKey: p.public_key,
        up: p.up,
        inbound: p.inbound,
      })),
    };
  }

  /** Drain one inbound message. Returns null if the queue is empty. */
  async recv(): Promise<AxlIncoming | null> {
    const res = await fetch(`${this.baseUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`/recv ${res.status}`);
    const fromPeerId = res.headers.get("x-from-peer-id");
    if (!fromPeerId) throw new Error("/recv missing X-From-Peer-Id");
    const body = Buffer.from(await res.arrayBuffer());
    return { fromPeerId, body };
  }

  async send(toPeerId: string, body: Buffer | string): Promise<void> {
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    const res = await fetch(`${this.baseUrl}/send`, {
      method: "POST",
      headers: {
        "x-destination-peer-id": toPeerId,
        "content-type": "application/octet-stream",
      },
      body: buf,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`/send ${res.status}: ${text}`);
    }
  }
}

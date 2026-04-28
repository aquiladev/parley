// Minimal HTTP client for the local AXL node. Mirror of mm-agent's copy.
// Consolidate into a shared transport package post-Phase-3.

export interface AxlIncoming {
  fromPeerId: string; // prefix-padded; do not compare with === to a raw pubkey
  body: Buffer;
}

export interface Topology {
  ourIpv6: string;
  ourPublicKey: string;
  peers: Array<{ publicKey: string; up: boolean; inbound: boolean }>;
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

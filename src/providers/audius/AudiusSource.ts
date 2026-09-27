/**
 * Audius as a PlayableSource for the SmartTrackResolver.
 * Only reports itself available after a real API request has succeeded.
 */
import type { TrackIdentity } from "../../matching/identity";
import { FULL_CAPABILITIES, type PlayableSource, type SourceAvailability, type SourceCandidate, type SourceCapabilities } from "../../matching/sources";
import type { AudiusClient, AudiusTrack } from "./AudiusClient";
import { audiusIdentity, audiusToTrackInfo } from "./audiusTracks";

/** Everything the engine supports, except recording (not granted by the Audius Open Music License). */
export const AUDIUS_CAPABILITIES: SourceCapabilities = { ...FULL_CAPABILITIES, canRecord: false };

export class AudiusSource implements PlayableSource {
  readonly id = "audius" as const;
  readonly name = "Audius";
  readonly remote = true;
  private readonly client: AudiusClient;

  constructor(client: AudiusClient) {
    this.client = client;
  }

  capabilities(): SourceCapabilities {
    return AUDIUS_CAPABILITIES;
  }

  availability(): SourceAvailability {
    const s = this.client.stats.apiStatus;
    if (s === "ok") return { available: true };
    if (s === "unknown") return { available: false, reason: "Audius API not tested yet (Settings → Streaming → Audius → Test connection)." };
    return { available: false, reason: `Audius API unreachable: ${this.client.stats.lastError ?? "error"}` };
  }

  /**
   * Minimal search terms only (artist + title) — the local library is never sent.
   * Falls back to a title-only query when the combined query finds nothing.
   */
  async search(identity: TrackIdentity): Promise<SourceCandidate[]> {
    const artist = identity.artists[0] ?? "";
    const title = identity.title.replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/\s+-\s+.*$/, "").trim();
    let tracks = await this.client.searchTracks(`${artist} ${title}`.trim(), 10);
    if (tracks.length === 0 && title) tracks = await this.client.searchTracks(title, 10);
    return tracks.filter((t) => t.streamable).map((t) => this.toCandidate(t));
  }

  async exists(id: string): Promise<boolean> {
    try {
      const t = await this.client.getTrack(id);
      return !!t && t.streamable;
    } catch {
      return false;
    }
  }

  async candidateFor(id: string): Promise<SourceCandidate | null> {
    const t = await this.client.getTrack(id).catch(() => null);
    return t && t.streamable ? this.toCandidate(t) : null;
  }

  private toCandidate(t: AudiusTrack): SourceCandidate {
    return { source: "audius", sourceTrackId: t.id, identity: audiusIdentity(t), track: audiusToTrackInfo(t), capabilities: AUDIUS_CAPABILITIES };
  }
}

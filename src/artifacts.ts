import { ServerApiClient, type ServerClientOptions } from "./server-api.js";
import type { components } from "./generated/types.js";

// ArtifactManifest is derived from the contract's artifact_manifest schema.
// Drift between SDK and contract is now a compile error.
export type ArtifactManifest = components["schemas"]["artifact_manifest"];

export interface ArtifactDownloadUrlsRequest {
  files?: Array<{
    path: string;
    chunkIndices?: number[];
  }>;
  expiresInSeconds?: number;
}

// TODO: bind to generated when schema is tightened (download-urls response uses an inline type in the contract).
export type ArtifactDownloadUrls = Record<string, unknown>;

export class ArtifactsClient extends ServerApiClient {
  constructor(options: ServerClientOptions = {}) {
    super(options);
  }

  async manifest(artifactId: string): Promise<ArtifactManifest> {
    return this.requestJson<ArtifactManifest>(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/manifest`,
      { method: "GET" },
    );
  }

  async downloadUrls(
    artifactId: string,
    request: ArtifactDownloadUrlsRequest,
  ): Promise<ArtifactDownloadUrls> {
    return this.requestJson<ArtifactDownloadUrls>(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/download-urls`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }
}

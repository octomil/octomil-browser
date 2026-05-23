import { OctomilError } from "./types.js";
import {
  ServerApiClient,
  type ServerClientOptions,
} from "./server-api.js";

// TODO: bind to generated when schema is tightened (training job ops use inline anonymous types in the contract).
export type TrainingJob = Record<string, unknown>;
// TODO: bind to generated when schema is tightened (job status/complete ops use inline anonymous types in the contract).
export type TrainingJobStatus = Record<string, unknown>;

export interface TrainingClientOptions extends ServerClientOptions {
  getDeviceId: () => string | null;
}

export class TrainingClient extends ServerApiClient {
  private readonly getDeviceId: () => string | null;

  constructor(options: TrainingClientOptions) {
    super(options);
    this.getDeviceId = options.getDeviceId;
  }

  async createJob(request: Record<string, unknown>): Promise<TrainingJob> {
    return this.requestJson<TrainingJob>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async jobStatus(
    jobId: string,
    request: Record<string, unknown>,
  ): Promise<TrainingJobStatus> {
    return this.requestJson<TrainingJobStatus>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs/${encodeURIComponent(jobId)}/status`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async jobComplete(
    jobId: string,
    request: Record<string, unknown>,
  ): Promise<TrainingJobStatus> {
    return this.requestJson<TrainingJobStatus>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs/${encodeURIComponent(jobId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  private requireDeviceId(): string {
    const deviceId = this.getDeviceId();
    if (!deviceId) {
      throw new OctomilError(
        "DEVICE_NOT_REGISTERED",
        "This operation requires a registered device ID.",
      );
    }
    return deviceId;
  }
}

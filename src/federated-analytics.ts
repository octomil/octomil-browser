/**
 * @octomil/browser — Federated analytics client
 *
 * Provides cross-site statistical analyses (descriptive stats, t-tests,
 * chi-square, ANOVA) and query history for federation members.
 *
 * API-compatible with the Android `FederatedAnalyticsApi` and
 * Python `FederatedAnalyticsClient`.
 */

import type {
  AnalyticsFilter,
  DescriptiveResult,
  TTestResult,
  ChiSquareResult,
  AnovaResult,
  AnalyticsQuery,
  AnalyticsQueryListResponse,
} from "./types.js";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FederatedAnalyticsOptions {
  /** Base URL of the Octomil server. */
  serverUrl: string;
  /** Optional API key for authenticated requests. */
  apiKey?: string;
}

export interface DescriptiveOptions {
  variable: string;
  groupBy?: string;
  groupIds?: string[];
  includePercentiles?: boolean;
  filters?: AnalyticsFilter;
}

export interface TTestOptions {
  variable: string;
  groupA: string;
  groupB: string;
  confidenceLevel?: number;
  filters?: AnalyticsFilter;
}

export interface ChiSquareOptions {
  variable1: string;
  variable2: string;
  groupIds?: string[];
  confidenceLevel?: number;
  filters?: AnalyticsFilter;
}

export interface AnovaOptions {
  variable: string;
  groupBy?: string;
  groupIds?: string[];
  confidenceLevel?: number;
  postHoc?: boolean;
  filters?: AnalyticsFilter;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class FederatedAnalyticsClient {
  private readonly serverUrl: string;
  private readonly apiKey?: string;

  constructor(options: FederatedAnalyticsOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
  }

  // -----------------------------------------------------------------------
  // Statistical Analyses
  // -----------------------------------------------------------------------

  /** Run descriptive statistics across groups in the federation. */
  async descriptive(options: DescriptiveOptions): Promise<DescriptiveResult> {
    return this.post<DescriptiveResult>("/api/v1/analytics/descriptive", {
      variable: options.variable,
      group_by: options.groupBy ?? "device_group",
      group_ids: options.groupIds ?? null,
      include_percentiles: options.includePercentiles ?? true,
      filters: options.filters ? serializeFilter(options.filters) : null,
    });
  }

  /** Run a two-sample t-test between two groups. */
  async tTest(options: TTestOptions): Promise<TTestResult> {
    return this.post<TTestResult>("/api/v1/analytics/t-test", {
      variable: options.variable,
      group_a: options.groupA,
      group_b: options.groupB,
      confidence_level: options.confidenceLevel ?? 0.95,
      filters: options.filters ? serializeFilter(options.filters) : null,
    });
  }

  /** Run a chi-square test of independence. */
  async chiSquare(options: ChiSquareOptions): Promise<ChiSquareResult> {
    return this.post<ChiSquareResult>("/api/v1/analytics/chi-square", {
      variable_1: options.variable1,
      variable_2: options.variable2,
      group_ids: options.groupIds ?? null,
      confidence_level: options.confidenceLevel ?? 0.95,
      filters: options.filters ? serializeFilter(options.filters) : null,
    });
  }

  /** Run a one-way ANOVA test across groups. */
  async anova(options: AnovaOptions): Promise<AnovaResult> {
    return this.post<AnovaResult>("/api/v1/analytics/anova", {
      variable: options.variable,
      group_by: options.groupBy ?? "device_group",
      group_ids: options.groupIds ?? null,
      confidence_level: options.confidenceLevel ?? 0.95,
      post_hoc: options.postHoc ?? true,
      filters: options.filters ? serializeFilter(options.filters) : null,
    });
  }

  // -----------------------------------------------------------------------
  // Query History
  // -----------------------------------------------------------------------

  /** List past analytics queries. */
  async listQueries(
    limit: number = 50,
    offset: number = 0,
  ): Promise<AnalyticsQueryListResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return this.get<AnalyticsQueryListResponse>(
      `/api/v1/analytics/queries?${params.toString()}`,
    );
  }

  /** Get a specific analytics query by ID. */
  async getQuery(queryId: string): Promise<AnalyticsQuery> {
    return this.get<AnalyticsQuery>(
      `/api/v1/analytics/queries/${encodeURIComponent(queryId)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Analytics request failed: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new OctomilError(
        "NETWORK_ERROR",
        `Analytics request failed: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize an AnalyticsFilter to snake_case for the API. */
function serializeFilter(
  filter: AnalyticsFilter,
): Record<string, unknown> {
  return {
    start_time: filter.startTime ?? null,
    end_time: filter.endTime ?? null,
    device_platform: filter.devicePlatform ?? null,
    min_sample_count: filter.minSampleCount ?? null,
  };
}

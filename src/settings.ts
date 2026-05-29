import { ServerApiClient, type ServerClientOptions } from "./server-api.js";
import type { components } from "./generated/types.js";

// Types derived from contract schemas — drift becomes a compile error.
export type CheckoutSession = components["schemas"]["CheckoutResponse"];
export type CheckoutSessionRequest = components["schemas"]["CheckoutRequest"];
export type PortalSession = components["schemas"]["PortalResponse"];
export type PortalSessionRequest = components["schemas"]["PortalRequest"];
// Legacy alias kept for backwards compatibility; callers that typed against
// BillingSession still compile because CheckoutSession and PortalSession now
// resolve to concrete shapes.
export type BillingSession = CheckoutSession | PortalSession;
// TODO: bind to generated when schema is tightened (updateBilling 200 is Record<string, never>).
export type BillingState = Record<string, unknown>;
export type UsageLimits = components["schemas"]["UsageLimitsResponse"];
export type UpdateUsageLimitsRequest = components["schemas"]["UpdateUsageLimitsRequest"];
export type Integration = components["schemas"]["IntegrationDetailResponse"];
export type IntegrationValidation = components["schemas"]["IntegrationTestResponse"];
export type IntegrationPatch = components["schemas"]["UpdateIntegrationRequest"];

export class SettingsClient extends ServerApiClient {
  constructor(options: ServerClientOptions = {}) {
    super(options);
  }

  async createCheckoutSession(
    request: CheckoutSessionRequest,
    orgId?: string,
  ): Promise<CheckoutSession> {
    return this.requestJson<CheckoutSession>(
      "/api/v1/settings/billing/checkout",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async createPortalSession(
    request: PortalSessionRequest,
    orgId?: string,
  ): Promise<PortalSession> {
    return this.requestJson<PortalSession>(
      "/api/v1/settings/billing/portal",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateBilling(
    request: components["schemas"]["UpdateBillingRequest"],
    orgId?: string,
  ): Promise<BillingState> {
    return this.requestJson<BillingState>(
      "/api/v1/settings/billing",
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async getUsageLimits(orgId?: string): Promise<UsageLimits> {
    return this.requestJson<UsageLimits>(
      "/api/v1/settings/usage-limits",
      { method: "GET" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateUsageLimits(
    request: UpdateUsageLimitsRequest,
    orgId?: string,
  ): Promise<UsageLimits> {
    return this.requestJson<UsageLimits>(
      "/api/v1/settings/usage-limits",
      {
        method: "PUT",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async getIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<Integration> {
    return this.requestJson<Integration>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      { method: "GET" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateIntegration(
    integrationId: string,
    request: IntegrationPatch,
    orgId?: string,
  ): Promise<Integration> {
    return this.requestJson<Integration>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async deleteIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<void> {
    await this.requestVoid(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      { method: "DELETE" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async validateIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<IntegrationValidation> {
    return this.requestJson<IntegrationValidation>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}/validate`,
      { method: "POST", body: JSON.stringify({}) },
      { org_id: orgId ?? this.orgId },
    );
  }
}

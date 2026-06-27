/**
 * rule-profiles-api — client per i profili-regole dell'ottimizzatore turni guida.
 * Catena: default azienda (company) → default progetto (project) → override live.
 */
import { apiFetch } from "@/lib/api";
import type { OperatorConfig } from "@/hooks/use-crew-optimization";

export type RuleProfileScope = "company" | "project";

export interface RuleProfile {
  id: string;
  scope: RuleProfileScope;
  projectId: string | null;
  name: string;
  serviceType: string | null;
  config: OperatorConfig;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listRuleProfiles(projectId?: string | null): Promise<RuleProfile[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const r = await apiFetch<{ profiles: RuleProfile[] }>(`/api/optimizer-rule-profiles${qs}`);
  return r.profiles;
}

export async function resolveRuleProfile(
  projectId?: string | null,
): Promise<{ config: OperatorConfig | null; sources: { company: boolean; project: boolean } }> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return apiFetch(`/api/optimizer-rule-profiles/resolve${qs}`);
}

export async function createRuleProfile(input: {
  name: string;
  scope: RuleProfileScope;
  projectId?: string | null;
  serviceType?: string | null;
  config: OperatorConfig;
  isDefault?: boolean;
}): Promise<RuleProfile> {
  const r = await apiFetch<{ profile: RuleProfile }>(`/api/optimizer-rule-profiles`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return r.profile;
}

export async function updateRuleProfile(
  id: string,
  patch: Partial<{ name: string; serviceType: string | null; config: OperatorConfig; isDefault: boolean }>,
): Promise<RuleProfile> {
  const r = await apiFetch<{ profile: RuleProfile }>(`/api/optimizer-rule-profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return r.profile;
}

export async function deleteRuleProfile(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/optimizer-rule-profiles/${id}`, { method: "DELETE" });
}

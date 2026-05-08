export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface OrbitConfigPrefs {
  enabled: boolean;
  /** Local 24-hour clock time in HH:mm format. Defaults to 08:00. */
  time: string;
  /** Optional skill id from the examples gallery where scenario === "orbit". */
  templateSkillId?: string | null;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  /**
   * Unix-millis timestamp of when the user resolved the first-run privacy
   * consent surface (Share or Decline). Set on first decision and on
   * subsequent toggles in Settings → Privacy. Independent of
   * installationId so that "Delete my data" can rotate the id without
   * re-popping the consent banner.
   */
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  /**
   * Fork-only (custom/004): when true, daemon routes all outbound HTTP
   * fetch (and propagates HTTPS_PROXY/HTTP_PROXY/NO_PROXY env into
   * spawned CLI children) through a hardcoded local proxy at
   * http://127.0.0.1:7890. Intended for users running Clash / Surge /
   * Mihomo Party with default ports who need both the daemon and the
   * agent CLIs to use the same egress.
   */
  manualProxyEnabled?: boolean;
}

/** Hardcoded manual-proxy endpoint exposed to clients so the Settings
 *  toggle's tooltip can render the same URL the daemon will dial. */
export const MANUAL_PROXY_HTTPS = 'http://127.0.0.1:7890';
export const MANUAL_PROXY_HTTP = 'http://127.0.0.1:7890';
export const MANUAL_PROXY_NO_PROXY = 'localhost,127.0.0.1,::1';

export interface AppConfigResponse {
  config: AppConfigPrefs;
}

export type UpdateAppConfigRequest = Partial<AppConfigPrefs>;

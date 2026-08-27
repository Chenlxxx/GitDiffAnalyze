import axios from 'axios';
import { ExternalEvidence, SkillBundle } from '../types';

export interface ExternalEvidenceRequestRisk {
  id: string;
  title?: string;
  severity?: string;
  risk_type?: string;
  trigger_condition?: string;
  affectedApis?: string[];
  affected_symbols?: any[];
  failure_signatures?: string[];
  local_search_terms?: string[];
  source_url?: string | null;
}

export async function collectExternalEvidenceForBundle(
  bundle: SkillBundle,
  repoUrl: string,
  fromVersion: string,
  toVersion: string,
  githubToken?: string
): Promise<ExternalEvidence[]> {
  const risks: ExternalEvidenceRequestRisk[] = (bundle.fileRisk || []).map((risk: any) => ({
    id: risk.id,
    title: risk.title,
    severity: risk.severity,
    risk_type: risk.risk_type,
    trigger_condition: risk.trigger_condition,
    affectedApis: risk.affectedApis || [],
    affected_symbols: risk.affected_symbols || [],
    failure_signatures: risk.failure_signatures || [],
    local_search_terms: risk.local_search_terms || [],
    source_url: risk.source_url || null
  }));

  if (risks.length === 0) return [];

  const headers: Record<string, string> = {};
  if (githubToken?.trim()) headers.Authorization = `token ${githubToken.trim()}`;

  const { data } = await axios.post('/api/external-evidence', {
    repoUrl,
    fromVersion,
    toVersion,
    manifest: bundle.manifest,
    risks
  }, { headers });

  return Array.isArray(data?.evidence) ? data.evidence : [];
}

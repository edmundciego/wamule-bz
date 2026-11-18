-- Signed, read-only map-review capabilities are server managed. The bearer
-- token is never stored; only its signed link ID and immutable review scope
-- are kept here so expiry and revocation can be checked on every request.
CREATE TABLE public.project_map_review_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  phase_id uuid NOT NULL REFERENCES public.development_phases(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.project_map_packages(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.map_feature_snapshots(id) ON DELETE CASCADE,
  package_digest text NOT NULL CHECK (length(package_digest) > 0),
  snapshot_fingerprint text NOT NULL CHECK (length(snapshot_fingerprint) > 0),
  settings_snapshot jsonb NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT project_map_review_links_phase_scope_fkey
    FOREIGN KEY (phase_id, project_id, tenant_id)
    REFERENCES public.development_phases(id, project_id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT project_map_review_links_snapshot_scope_fkey
    FOREIGN KEY (snapshot_id, tenant_id, project_id, phase_id)
    REFERENCES public.map_feature_snapshots(id, tenant_id, project_id, phase_id) ON DELETE CASCADE,
  CONSTRAINT project_map_review_links_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT project_map_review_links_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX project_map_review_links_scope_idx
  ON public.project_map_review_links (tenant_id, project_id, phase_id, created_at DESC);

ALTER TABLE public.project_map_review_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_map_review_links FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.project_map_review_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.project_map_review_links TO service_role;

COMMENT ON TABLE public.project_map_review_links IS
  'Server-managed, signed, expiring, revocable read-only capabilities for an exact reviewed map package and settings snapshot. No browser role has table access.';

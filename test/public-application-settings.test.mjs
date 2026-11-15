import test from "node:test";
import assert from "node:assert/strict";
import { resolvePublicApplicationSettings } from "../supabase/functions/_shared/public-application-settings.mjs";

const completeCompany = {
  applications_open: true,
  public_notice_text: "Company notice",
  application_acknowledgment_text: "Company acknowledgment",
};

test("applications require explicit company and project opt-in", () => {
  assert.equal(resolvePublicApplicationSettings(completeCompany, { applications_open: true }).applicationsOpen, true);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { applications_open: false }).applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings({ ...completeCompany, applications_open: false }, { applications_open: true }).applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, {}).applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings({}, { applications_open: true }).applicationsOpen, false);
});

test("project notice fields override company fields independently", () => {
  const result = resolvePublicApplicationSettings(completeCompany, {
    applications_open: false,
    public_notice_text: "Project notice",
  });
  assert.equal(result.publicNoticeText, "Project notice");
  assert.equal(result.acknowledgmentText, "Company acknowledgment");
  assert.equal(result.noticesComplete, true);
});

test("an explicitly blank or malformed project notice does not silently inherit", () => {
  const result = resolvePublicApplicationSettings(completeCompany, {
    public_notice_text: "  ",
    application_acknowledgment_text: false,
  });
  assert.equal(result.publicNoticeText, "");
  assert.equal(result.acknowledgmentText, "");
  assert.equal(result.noticesComplete, false);
});

test("missing company/project settings fail closed and remain incomplete", () => {
  assert.deepEqual(resolvePublicApplicationSettings(null, null), {
    applicationsOpen: false,
    publicNoticeText: "",
    acknowledgmentText: "",
    noticesComplete: false,
  });
});

test("a configured phase allowlist opens only exact verified phase IDs and excludes unknown phases", () => {
  const initial = "fbc1ae08-ef46-4d80-85f5-8e3a8d049116";
  const other = "30d37009-ff5d-4bbb-8312-9a7311b010a8";
  const project = { applications_open: true, allowed_phase_ids: [initial] };

  assert.equal(resolvePublicApplicationSettings(completeCompany, project, initial).applicationsOpen, true);
  assert.equal(resolvePublicApplicationSettings(completeCompany, project, other).applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, project, "40d37009-ff5d-4bbb-8312-9a7311b010a8").applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { ...project, allowed_phase_ids: [] }, initial).applicationsOpen, false);
});

test("a present malformed phase allowlist fails closed while a missing key preserves legacy projects", () => {
  const initial = "fbc1ae08-ef46-4d80-85f5-8e3a8d049116";
  const openProject = { applications_open: true };
  assert.equal(resolvePublicApplicationSettings(completeCompany, openProject, initial).applicationsOpen, true);

  for (const allowed_phase_ids of [null, "all", ["not-a-uuid"], [initial, 42]]) {
    assert.equal(
      resolvePublicApplicationSettings(completeCompany, { ...openProject, allowed_phase_ids }, initial).applicationsOpen,
      false,
    );
  }
  assert.equal(
    resolvePublicApplicationSettings(completeCompany, { ...openProject, allowed_phase_ids: [initial] }).applicationsOpen,
    false,
    "an allowlisted project must receive the server-resolved phase ID",
  );
});

test("phase allowlisting does not override existing company or project closure", () => {
  const initial = "fbc1ae08-ef46-4d80-85f5-8e3a8d049116";
  const project = { applications_open: true, allowed_phase_ids: [initial] };
  assert.equal(resolvePublicApplicationSettings({ ...completeCompany, applications_open: false }, project, initial).applicationsOpen, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { ...project, applications_open: false }, initial).applicationsOpen, false);
});

test("project applications require a notice version and at least one configured intended use", () => {
  const phase = "fbc1ae08-ef46-4d80-85f5-8e3a8d049116";
  const base = {
    application_type: "project_application",
    applications_open: true,
    allowed_phase_ids: [phase],
    notice_version: "review-v1",
    allowed_intended_uses: ["Residential"],
  };
  assert.equal(resolvePublicApplicationSettings(completeCompany, base, phase).noticesComplete, true);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { ...base, notice_version: " " }, phase).noticesComplete, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { ...base, allowed_intended_uses: [] }, phase).noticesComplete, false);
  assert.equal(resolvePublicApplicationSettings(completeCompany, { ...base, allowed_intended_uses: "Residential" }, phase).noticesComplete, false);
});

# Map Studio Workflow v2: Admin publication and shared project links

This walkthrough is for the isolated staging rehearsal of the Map Studio Admin controls and shared slug routes. Start with staging’s reviewed **73 numbered migrations** plus the separate **M1.5 overlay** in the disposable Linux Supabase stack. Do not substitute a 69-entry replay or apply onboarding SQL by hand. No DNS or hostname binding is part of this workflow.

The 73-row attachment referenced for this run was not present in the checkout. The review branch carries a reconciled copy built from the captured 69-row inventory and the four reviewed migration sources, with the separate M1.5 placement recorded after `20261112033403`. CI verifies every version, filename, and SHA-256 against that copy and excludes `20261112040000`. Compare the artifact with the original attachment before treating it as an exact attachment-to-run match.

## Configure the project

1. Sign in to the disposable Admin test identity and select **Wamule → Synthetic Review Project → Initial** from the workspace selector.
2. Open **Settings → Company Profile**. Confirm the tenant-wide application gate starts closed. Under **Public Application Settings**, preserve the existing notice, acknowledgment, module selections, and business values. For this rehearsal, keep the tenant gate closed while preparing the project-specific form.
3. In the same section, set the public-site template used by the workspace and make sure **Project map** and **Applications** are enabled. Keep this presentation setting separate from the application controls below.
4. Open **Settings → Project Applications**. Set **Application type** to **Project application**. Enter the reviewed notice version, public notice, applicant acknowledgment, intended-use options, maximum map-outline preferences, and confirmation message. Select **Initial** and clear **Later** under **Allowed phases**. Keep both intake gates closed while preparing and publishing the map.

## Publish the reviewed map

1. Open **Maps** for the same selected workspace.
2. Under **Publish reviewed map package**, select the fully reviewed Map Studio package. Confirm the target phase and immutable package revision shown by Admin. All package outlines must be marked reviewed.
3. Choose **Review publish details**, confirm the target phase and revision in the dialog, acknowledge that the package will become the displayed map, then choose **Publish map**. The RPC checks tenant/project/phase scope and the expected active snapshot revision. Map publication does not change either intake gate.
4. Use **Maps → Shared project links** to copy the full project application link and full map link. Both links include the selected tenant, project, and phase slugs. Do not create a hostname binding.
5. Return to **Settings → Project Applications** and open the project gate with only **Initial** allowed. Review **Effective intake by phase**. Open **Company Profile → Public Application Settings → Applications open** only for the short rehearsal window. The panel must show Initial **Open** and Later **Closed** before submission.

## Signed-out verification

1. Open both shared links in a clean signed-out browser context. The project page must display the Synthetic Review Project application form and the map link must display the Initial published map. Requests use the tenant/project/phase slugs directly; verify there are no `resolve_public_hostname` requests and no `host` query parameter.
2. On the map, select outline **SYN-001**. Return to the project form and confirm the selected outline is shown as a preference, with no parcel assignment.
3. Confirm the effective intake panel still shows Initial open and Later closed. Submit one synthetic project application, then retry the exact payload with the same submission reference. Verify the retry returns the original application ID, and Admin shows one Initial application and one linked lead. The application must preserve the SYN-001 map-feature reference and provide a working shared map link back to that outline.
4. Verify there were zero email sends, zero payment writes, and zero reservation writes. The form is an interest/application record only.
5. If an existing expired link is available in the signed-out browser, make the background request once and record its HTTP response status only. Do not copy the link or token into notes, artifacts, or chat. If no existing link is available, record that the check was unavailable.

## Close and record

1. In **Settings → Project Applications**, turn off the project intake gate for Synthetic Review Project.
2. Restore the tenant-wide gate to its original closed value in **Settings → Company Profile → Public Application Settings**. Confirm every phase for the Synthetic Review Project is effectively closed.
3. Record the selected map package revision, application ID, linked lead count, selected outline reference, retry result, email/payment/reservation counts, hostname-binding count, expired-link response status (or unavailable), migration inventory/hash, M1.5 overlay hash, tested commit, and CI run URL.
4. Report hands-on and waiting time only if a human operator performed those actions. An automated CI or agent run must not be represented as human-operated time.

## Shared staging release scope

The shared staging release consists of the Admin project-application settings RPC migration, the existing Map Studio package publication RPC/UI, slug-based `/p/:tenant/:project` and `/map` routes, and the compatible public Edge Function updates. It does not include hostname bindings, tenant-specific frontend deployments, DNS changes, production changes, outbound email configuration, payment/reservation behavior, or manual onboarding SQL. Keep the tenant and project intake gates closed after the rehearsal.

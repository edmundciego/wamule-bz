# PR #9 homepage layout parity — 20 November 2026

The preview configuration blocker is cleared. Both layouts render staging data. This evidence compares the refactor with fresh current staging captures, including Wamule's crab logo. It supersedes the earlier error-screen comparison as layout evidence.

## Deploy and source identity

| | Fresh staging baseline | Refactor deploy preview |
|---|---|---|
| Deploy ID | `6afdf7e7f6aeaf149dd69e0c` | `6b00b6d415fdb0b426a21cec` |
| Full source SHA | `fc7872decf962c5b643e8ec5ec0510acd0310b9f` | `20d502e8223f815695374435d52b5107460ff3d0` |
| Source evidence | [Verified release record in PR #3](https://github.com/edmundciego/wamule-bz/pull/3) and matching previously verified entry assets | Netlify deploy `commit_ref` |

The preview head is an empty rebuild commit. Its tree is exactly the reviewed `28bf722ab6a30121c1f58089088d3ff96e5a2626` tree, `48d8c10fa865eb13b7170484b56411c7f0bca7fc`. PR #9 still changes nine homepage/theme/test files and contains no migration. PR #10 remains separate.

Only the two public Supabase variables in Netlify's **deploy-preview** context were updated. The rebuilt frontend embeds the staging host `kvocwmrcuhiaezlcgzjf.supabase.co`. The published production deploy stayed `6aa8c6f00bf61a0008fb7deb` before and after. No database writes or form submissions were performed.

## Live routes

| Project | Staging baseline | Preview |
|---|---|---|
| Wamule | https://wamule-staging.netlify.app/p/wamule/wamule?phase=default | https://deploy-preview-9--wamule-bz.netlify.app/p/wamule/wamule?phase=default |
| Hopkins Grove | https://ceiba-test.wamuledevelopment.com/hopkins?phase=initial | https://deploy-preview-9--wamule-bz.netlify.app/p/hopkins-grove/hopkins-grove?phase=initial |

## Capture conditions and results

The signed-out captures use the same browser session. Desktop: **1363 × 936 CSS pixels**, DPR 1. Phone width: **340 × 234 CSS pixels**, DPR 4, simulated with 400% browser zoom. These are phone-width browser captures, not mobile-device emulation. Explicit screenshot clip dimensions account for browser zoom. The Netlify preview drawer was dismissed. Final full-page images have no masking, stitching, or CSS overrides.

| Project / width | Full-page dimensions | Changed pixels | Difference | Baseline | Preview | Exact pixel diff |
|---|---:|---:|---:|---|---|---|
| Wamule desktop | 1363 × 1437 | 0 | 0% | [image](wamule-desktop-staging.jpg) | [image](wamule-desktop-preview.jpg) | [diff](wamule-desktop-diff.png) |
| Wamule phone | 340 × 2064 | 0 | 0% | [image](wamule-phone-staging.jpg) | [image](wamule-phone-preview.jpg) | [diff](wamule-phone-diff.png) |
| Hopkins desktop | 1363 × 3066 | 0 | 0% | [image](hopkins-desktop-staging.jpg) | [image](hopkins-desktop-preview.jpg) | [diff](hopkins-desktop-diff.png) |
| Hopkins phone | 340 × 4454 | 1065 | 0.0703267% | [image](hopkins-phone-staging.jpg) | [image](hopkins-phone-preview.jpg) | [diff](hopkins-phone-diff.png) |

The first three pairs are also byte-for-byte identical JPEG files. Every differing pixel in the Hopkins phone pair is within the plan image, rectangle `(96,1519)` to `(257,1633)`; the largest RGB-channel delta is 22/255. No page text, spacing, branding, controls, or other region differs.

**Same-deploy control:** An [earlier capture of this same preview deploy](hopkins-phone-preview-control.jpg) matches the final staging capture below the top cursor area. Comparing that control with the final preview reproduces exactly the same 1065 map pixels, rectangle, and maximum delta. This isolates the remaining variation to repeat capture/rasterization within an unchanged preview, rather than a layout change. [Control comparison](same-deploy-control-comparison.json) · [Raw pixel counts and screenshot SHA-256 hashes](pixel-comparison.json).

Wamule renders `data-site-template="wamule-classic"` with the crab logo. Hopkins renders `data-site-template="hopkins-project"`, Ceiba Realty & Development, and **“A place to put down roots.”** Its published map, inquiry panel, and project application render. Wamule's current unpublished-map/closed-application state is identical on both origins.

## Plot-to-application check

On the preview, selecting generated **Plot 559** shows **BZD 30,000 · per 1/4 acre**. Clicking **Apply with this plot** opens the scoped project application with:

`apply_feature=6f41f449-8c6a-4b2e-a515-914a86d7721f`

The application status and summary retain **“Plot 559 · Reference price: BZD 30,000 · per 1/4 acre.”** [Application screenshot](plot-559-application-preview.jpg) · [Observed URL and status](plot-559-application-preview.json). No form was filled or submitted.

## Checks

- [Build: passed](https://github.com/edmundciego/wamule-bz/actions/runs/44817660618/job/136570070405).
- [Supabase RPC fresh-database contract: passed](https://github.com/edmundciego/wamule-bz/actions/runs/44817660463/job/136570069935).
- [Full suite](https://github.com/edmundciego/wamule-bz/actions/runs/44817660618/job/136570701365): 331 tests, **293 passed, 34 failed, 4 skipped**. Every failing name is listed in issue #4; zero new names. These are the actual CI totals; the earlier 294/33 figures were local totals.
- The separate schema-contract run on the identical source tree stopped on the existing Deno unused-variable lint errors before database replay; it is outside the agreed required gates.

Palette data migration/deletion of the temporary slug preset remains issue #11. The staging migration-history repair is separate and must precede the next migration push. No migration was applied for this refactor.

[Machine-readable release record](release-record.json) · [Published frontend asset hashes](frontend-assets.json).

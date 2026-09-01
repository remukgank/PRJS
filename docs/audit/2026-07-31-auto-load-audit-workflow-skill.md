# Fix: Auto-load audit-workflow skill

**Date**: 2026-07-31
**Author**: opencode

## Root Cause

Aturan workflow (proposal → approval → implement → audit log → commit) diletakkan di `.agents/skills/audit-workflow/SKILL.md`, tapi folder `.agents/skills/` **tidak di-scan** oleh opencode saat start sesi. Akibatnya aturan tidak pernah masuk context agent secara otomatis, sehingga sering terlewat (misal: teks user-facing menyebut "AI", langsung commit tanpa proposal).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `.opencode/skills/audit-workflow/SKILL.md` | Copy dari `.agents/skills/audit-workflow/SKILL.md` + tambah frontmatter `name` & `description` (wajib — tanpa itu skill di-filter opencode) |

## Detail Teknis

Skill yang auto-load opencode hanya dari `.opencode/skills/**/SKILL.md`. `.agents/` adalah konvensi Claude Code yang tidak dibaca opencode. Copy isi skill tanpa modifikasi.

## Verification

- File ter-copy di `.opencode/skills/audit-workflow/SKILL.md` + frontmatter `name`/`description`
- Sesi berikutnya skill ini akan muncul di available_skills

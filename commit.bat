@echo off
cd /d C:\Users\electrolux\Desktop\codehub\github\Siphon
del tests\e2e\diag.mjs tests\e2e\diag2.mjs tests\e2e\diag3.mjs tests\e2e\diag4.mjs tests\e2e\epi.mjs tests\e2e\chk.mjs 2>nul
git add -A
echo === STAGED ===
git status --short

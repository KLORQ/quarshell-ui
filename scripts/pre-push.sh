#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
had_dist=0
had_test_results=0
had_playwright_report=0
[ ! -e dist ] || had_dist=1
[ ! -e test-results ] || had_test_results=1
[ ! -e playwright-report ] || had_playwright_report=1
cleanup() {
  [ "$had_dist" -eq 1 ] || rm -rf dist
  [ "$had_test_results" -eq 1 ] || rm -rf test-results
  [ "$had_playwright_report" -eq 1 ] || rm -rf playwright-report
}
trap cleanup EXIT HUP INT TERM
command -v node >/dev/null 2>&1 || { echo 'Node.js 22 is required' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required' >&2; exit 1; }
npm ci
npm run check
npm run build
npx playwright install chrome
npm run test:e2e
printf 'pre-push: PASS\n'

name: Generate Project Pages + Pulse

on:
  schedule:
    # Runs every night at 2am UTC (10pm EST)
    - cron: '0 2 * * *'
  workflow_dispatch:
    # Also allows manual trigger from GitHub Actions tab

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Generate project pages
        run: python3 generate_pages.py

      - name: Generate Pulse feed
        run: python3 generate_pulse.py

      - name: Check for changes
        id: changes
        run: |
          git add projects/ sitemap.xml robots.txt pulse.json .pulse-snapshot.json
          if git diff --staged --quiet; then
            echo "changed=false" >> $GITHUB_OUTPUT
          else
            echo "changed=true" >> $GITHUB_OUTPUT
            echo "Changes detected:"
            git diff --staged --name-only | head -20
          fi

      - name: Commit and push
        if: steps.changes.outputs.changed == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          PAGE_COUNT=$(git diff --staged --name-only | grep "index.html" | wc -l)
          PULSE_CHANGED=$(git diff --staged --name-only | grep -c "pulse.json" || echo "0")
          if [ "$PAGE_COUNT" -gt "0" ] && [ "$PULSE_CHANGED" -gt "0" ]; then
            MSG="Auto-generate: ${PAGE_COUNT} pages + Pulse feed updated [skip ci]"
          elif [ "$PAGE_COUNT" -gt "0" ]; then
            MSG="Auto-generate project pages (${PAGE_COUNT} pages updated) [skip ci]"
          else
            MSG="Update Pulse feed [skip ci]"
          fi
          git commit -m "$MSG"
          git push

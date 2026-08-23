# {{NAME}}

{{DESCRIPTION_BLOCK}}Scaffolded by `bskel new --stack fastapi`.

## Run it

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
fastapi dev app/main.py --port {{PORT}}     # or: uvicorn app.main:app --reload --port {{PORT}}
```

Then check http://127.0.0.1:{{PORT}}/health

{{DATABASE_SECTION}}## Next steps

This is a local-only git repository with one commit. `bskel preflight` needs a real `origin`
remote with a resolvable default branch, so:

```bash
gh repo create <name> --private --source=. --push   # or push to a remote you already own
git remote set-head origin --auto
bskel preflight
```

From there, `bskel status` / `bskel next` will tell you what to run.

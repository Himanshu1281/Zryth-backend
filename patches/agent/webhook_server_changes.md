# Changes to Zryth-Voice-agent/webhook_server.py

## 1. Remove the wide-open CORS block
The browser should never call the agent directly anymore. Delete:

    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)

## 2. Protect /internal/ai/summarize (currently has NO auth — anyone can burn your Gemini key)
Add a shared helper and use it on every /internal route:

```python
def _verify(secret: str | None):
    if not WEBHOOK_SECRET or not secret or not hmac.compare_digest(secret, WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

@app.post("/internal/ai/summarize")
async def summarize_call(
    req: SummarizeRequest,
    x_webhook_secret: str | None = Header(default=None),
):
    _verify(x_webhook_secret)
    ...  # rest unchanged
```

## 3. Bind to localhost / private interface only
In deploy/voice-agent.service (or however you start uvicorn), run:

    uvicorn webhook_server:app --host 0.0.0.0 --port 8000

and in the EC2 Security Group allow port 8000 ONLY from the backend's
security group / IP. If the backend runs on the same EC2: use --host 127.0.0.1
and AGENT_BASE_URL=http://127.0.0.1:8000.

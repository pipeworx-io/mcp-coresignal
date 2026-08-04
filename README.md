# mcp-coresignal

Coresignal MCP — LinkedIn-adjacent company + employee data (coresignal.com)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `coresignal_company` | Look up a company's firmographics + headcount (size, employee count, industry, founding year, HQ, LinkedIn URL) from Coresignal by company name or website. LinkedIn-adjacent B2B data. Example: coresignal_company({ name: "Stripe", _apiKey: "your-key" }) |
| `coresignal_employee` | Find a person's professional profile by name (+company) via Coresignal — returns title, current company, location, LinkedIn URL, work experience and education. LinkedIn-adjacent people data. Example: coresignal_employee({ name: "Patrick Collison", company: "Stripe", _apiKey: "your-key" }) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "coresignal": {
      "url": "https://gateway.pipeworx.io/coresignal/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Coresignal data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

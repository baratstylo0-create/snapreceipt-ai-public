# Receipt Analyser SaaS — Documentation

> A clean, professional documentation package for the Receipt Analyser SaaS platform — an AI-powered receipt-to-expense system with a Telegram bot, a web dashboard, and a flag-gated multi-branch business layer.
>
> _Audience: internal team. Based entirely on the current implementation. Items that cannot be verified from the code are marked **"Requires Manual Review."**_

## Contents

| # | Document | What's inside |
|---|---|---|
| 01 | [Project Overview](01_Project_Overview.md) | What the product is, who it's for, and how it works at a glance |
| 02 | [System Architecture](02_System_Architecture.md) | Components, request flows, and design principles (with diagrams) |
| 03 | [Features](03_Features.md) | Everything the product does — core, dashboard, bot, and business layer |
| 04 | [AI Workflow](04_AI_Workflow.md) | How receipts are read, categorised, and how the AI agent answers questions |
| 05 | [Folder Structure](05_Folder_Structure.md) | How the codebase is organised |
| 06 | [Database Overview](06_Database_Overview.md) | Tables, relationships, and isolation model (with ER diagram) |
| 07 | [API Overview](07_API_Overview.md) | Every endpoint, who can call it, and how it's secured |
| 08 | [Security](08_Security.md) | Authentication, isolation, data protection, and hardening |
| 09 | [Deployment](09_Deployment.md) | Repo → live, always-on, HTTPS — per client |
| 10 | [User Guide](10_User_Guide.md) | Step-by-step, non-technical usage guide |
| 11 | [Future Improvements](11_Future_Improvements.md) | Planned operations, hardening, and enhancements |

## Quick facts
| | |
|---|---|
| Backend | Node.js (≥20) + Express |
| Database & storage | Supabase (PostgreSQL + Storage) |
| AI | Groq-hosted vision + text models |
| Frontend | Vanilla JavaScript (no framework) |
| Capture channels | Telegram bot + web dashboard |
| Tenancy | One isolated instance per client (managed silo) |
| Modes | Personal (default) and Business (flag-gated) |

## A single combined PDF
A print-ready version of this whole package is available as **`Project_Documentation.pdf`** (in the project root), with a cover page, table of contents, and page numbers — suitable for client delivery, onboarding, and portfolio use.

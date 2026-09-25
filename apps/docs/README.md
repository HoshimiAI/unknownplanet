# Unknown Planet documentation site

This Fumadocs app documents the Unknown Planet SDK, provider adapters, and example HTTP API. Content lives in `content/docs`; `content/docs/meta.json` defines the sidebar order. The source loader and layouts are in `lib/source.ts` and `app/docs`.

From the repository root, run the site with:

```sh
bun run --cwd apps/docs dev
```

The local site runs at `http://localhost:3000`. To check the docs app:

```sh
bun run --cwd apps/docs types:check
bun run --cwd apps/docs build
bun run --cwd apps/docs lint
```

Content should describe behavior present in the SDK and `apps/elysia`. Provider credentials, database setup, and Atlas Vector Search indexes belong to the application deployment and are covered in the Operations and Providers pages.

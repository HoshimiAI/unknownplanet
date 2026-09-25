import Link from 'next/link';

const areas = [
  { title: 'Graph and retrieval', description: 'Build connected knowledge and combine keyword, vector, and graph search.', href: '/docs/features' },
  { title: 'Memory and documents', description: 'Store scoped memories, ingest documents, and track durable jobs.', href: '/docs/features' },
  { title: 'Storage providers', description: 'Route capabilities to PostgreSQL, MongoDB, or custom adapters.', href: '/docs/providers' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-20">
      <div className="w-full max-w-5xl">
        <p className="mb-3 text-sm font-semibold text-fd-primary">Unknown Planet</p>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight md:text-6xl">
          One data layer for connected knowledge.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-fd-muted-foreground">
          Route graph, vector, memory, and document capabilities across storage providers through one TypeScript SDK.
        </p>
        <div className="mt-8 flex gap-4">
          <Link href="/docs/quickstart" className="rounded-lg bg-fd-primary px-5 py-3 font-medium text-fd-primary-foreground">
            Get started
          </Link>
          <Link href="/docs" className="rounded-lg border px-5 py-3 font-medium">
            Read the docs
          </Link>
        </div>
        <div className="mt-16 grid gap-4 md:grid-cols-3">
          {areas.map((area) => (
            <Link key={area.title} href={area.href} className="rounded-xl border p-6 transition-colors hover:bg-fd-accent">
              <h2 className="font-semibold">{area.title}</h2>
              <p className="mt-2 text-sm text-fd-muted-foreground">{area.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}

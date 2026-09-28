import type { ComponentType } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// dashboard.md §11: placeholder screens show a proper empty state saying "Coming in <ticket>" —
// never invented numbers or fake data.
export function EmptyState({
  icon: Icon,
  title,
  ticket,
  description,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly title: string;
  readonly ticket: string;
  readonly description?: string;
}) {
  return (
    <Card className="flex flex-1 items-center justify-center border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <Icon className="size-10 text-muted-foreground" />
        <CardHeader className="p-0">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
        <p className="max-w-sm text-sm text-muted-foreground">
          Coming in {ticket}. {description}
        </p>
      </CardContent>
    </Card>
  );
}

import { BarChart3, FileText, Receipt } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

export function AnalyticsPlaceholderPage() {
  return (
    <EmptyState
      icon={BarChart3}
      title="Analytics"
      ticket="M3-4"
      description="Overview KPIs, delivered vs. placed ROAS and platform-reported comparisons land with the reporting API."
    />
  );
}

export function AttributionPlaceholderPage() {
  return (
    <EmptyState
      icon={FileText}
      title="Attribution"
      ticket="M3-3/M3-4"
      description="The channel → campaign → ad breakdown table and model comparison land with the attribution engine."
    />
  );
}

export function OrdersPlaceholderPage() {
  return (
    <EmptyState
      icon={Receipt}
      title="Order journeys"
      ticket="M3-4"
      description="Search by order id to see the touchpoint timeline and per-model credits."
    />
  );
}

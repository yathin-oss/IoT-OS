import { AlertTriangle, Ban, CircleX, Info } from 'lucide-react';
import type { Severity } from '../../../core/diagnostics';

export function SeverityIcon({ severity, size = 13 }: { severity: Severity; size?: number }) {
  const cls = `sev-${severity}`;
  switch (severity) {
    case 'blocking':
      return <Ban size={size} className={cls} style={{ flex: 'none' }} />;
    case 'error':
      return <CircleX size={size} className={cls} style={{ flex: 'none' }} />;
    case 'warning':
      return <AlertTriangle size={size} className={cls} style={{ flex: 'none' }} />;
    default:
      return <Info size={size} className={cls} style={{ flex: 'none' }} />;
  }
}

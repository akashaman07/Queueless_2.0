import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'QueueLess — Skip the queue',
  description: 'Scan items as you shop and check out without the usual wait.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

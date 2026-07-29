import { pick, int } from '../lib/rng.js';
import { DELIVERY_PRODUCTS } from '../../../shared/src/moduleConfig.js';

export const FIRST_NAMES = [
  'Chidi', 'Fatima', 'Adesuwa', 'Ezekiel', 'Blessing', 'Ifeanyi', 'Samuel', 'Bimpe', 'Akingba', 'Samiolu',
  'Ngozi', 'Tunde', 'Aisha', 'Emeka', 'Grace', 'Yusuf', 'Chioma', 'Bala', 'Uche', 'Halima',
  'Femi', 'Amaka', 'Kabiru', 'Rita', 'Obinna', 'Zainab', 'Kelechi', 'Musa', 'Adaeze', 'Hassan',
];
export const LAST_NAMES = [
  'Okafor', 'Bello', 'Johnson', 'Adegoke', 'Nwosu', 'Ude', 'Oke', 'Musa', 'Ojuma', 'Agbo',
  'Ibrahim', 'Eze', 'Abubakar', 'Balogun', 'Chukwu', 'Danladi', 'Adeyemi', 'Yakubu', 'Nnamdi', 'Suleiman',
];
export const BUSINESS_SUFFIX = ['Ventures', 'Stores', 'Ltd.', 'Distribution', '& Sons', 'Depot', 'Enterprises', 'Trading Co.'];
export const LOCATIONS = [
  'Gwagwalada, FCT', 'Kubwa, FCT', 'Lugbe, FCT', 'Nyanya, FCT', 'Karu, Nasarawa', 'Dutse, FCT',
  'Idu, FCT', 'Wuse, FCT', 'Garki, FCT', 'Jikwoyi, FCT', 'Mararaba, Nasarawa', 'Kuje, FCT',
];
export const PRODUCTS = DELIVERY_PRODUCTS;

export const fullName = (rng: () => number) => `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
export const businessName = (rng: () => number) => `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)} ${pick(rng, BUSINESS_SUFFIX)}`;
export const emailFor = (name: string) => name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@elimwater.ng';

const dateFmt = new Intl.DateTimeFormat('en-NG', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

export function recentDate(rng: () => number, daysBack = 14): Date {
  const d = new Date();
  d.setDate(d.getDate() - int(rng, 0, daysBack));
  d.setHours(int(rng, 7, 18), pick(rng, [0, 15, 30, 45]), 0, 0);
  return d;
}
export function futureDate(rng: () => number, daysFwd = 60): Date {
  const d = new Date();
  d.setDate(d.getDate() + int(rng, 1, daysFwd));
  return d;
}
export const fmtDate = (d: Date) => dateFmt.format(d);
export const fmtDateTime = (d: Date) => dateTimeFmt.format(d);
export const naira = (n: number) => '₦' + Math.round(n).toLocaleString('en-NG');

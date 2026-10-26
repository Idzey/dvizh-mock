// Сравнение строк как в Postgres (collation C) и Java (String.compareTo): по кодовым единицам, а не по русской локали.
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

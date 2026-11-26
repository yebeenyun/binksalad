function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${month}-01`;
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return { start, end: next.toISOString().slice(0, 10) };
}

function priorMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toMonthDate(date) {
  return date.toISOString().slice(0, 10);
}

export function dashboardForMonth(db, householdId, month) {
  const { start, end } = monthBounds(month);
  const previousMonth = priorMonth(month);
  const previousBounds = monthBounds(previousMonth);

  const totalsQuery = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS expenses,
      COUNT(*) AS transactionCount
    FROM transactions
    WHERE household_id = ? AND transaction_date >= ? AND transaction_date < ?
  `);
  const current = totalsQuery.get(householdId, start, end);
  const previous = totalsQuery.get(householdId, previousBounds.start, previousBounds.end);
  const categoryRows = db.prepare(`
    SELECT c.id, c.name, c.category_type AS type, SUM(-t.amount) AS amount
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.household_id = ? AND t.transaction_type = 'expense'
      AND t.transaction_date >= ? AND t.transaction_date < ?
    GROUP BY c.id
    ORDER BY amount DESC
  `).all(householdId, start, end);

  const previousCategories = new Map(db.prepare(`
    SELECT c.name, SUM(-t.amount) AS amount
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    WHERE t.household_id = ? AND t.transaction_type = 'expense'
      AND t.transaction_date >= ? AND t.transaction_date < ?
    GROUP BY c.name
  `).all(householdId, previousBounds.start, previousBounds.end)
    .map(row => [row.name, row.amount]));

  const trends = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - offset, 1));
    const trendMonth = date.toISOString().slice(0, 7);
    const bounds = monthBounds(trendMonth);
    const totals = totalsQuery.get(householdId, bounds.start, bounds.end);
    trends.push({ month: trendMonth, income: totals.income, expense: totals.expenses });
  }

  const topMerchants = db.prepare(`
    SELECT description AS merchant, SUM(-amount) AS amount, COUNT(*) AS count
    FROM transactions
    WHERE household_id = ? AND transaction_type = 'expense'
      AND transaction_date >= ? AND transaction_date < ?
    GROUP BY description
    ORDER BY amount DESC
    LIMIT 5
  `).all(householdId, start, end);

  const recurring = db.prepare(`
    SELECT description AS merchant, COUNT(DISTINCT substr(transaction_date, 1, 7)) AS months,
      SUM(-amount) / COUNT(DISTINCT substr(transaction_date, 1, 7)) AS averageAmount
    FROM transactions
    WHERE household_id = ? AND transaction_type = 'expense'
      AND transaction_date >= ? AND transaction_date < ?
    GROUP BY description
    HAVING COUNT(DISTINCT substr(transaction_date, 1, 7)) >= 3
    ORDER BY months DESC, averageAmount DESC
    LIMIT 5
  `).all(householdId, toMonthDate(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 6, 1))), end);

  const latestImport = db.prepare(`
    SELECT import_date AS importedAt, transaction_count AS transactionCount,
      duplicate_count AS duplicateCount, import_status AS status
    FROM import_history WHERE household_id = ? AND import_status = 'completed'
    ORDER BY import_date DESC LIMIT 1
  `).get(householdId);

  const insights = [];
  for (const category of categoryRows) {
    const priorAmount = previousCategories.get(category.name) || 0;
    if (priorAmount > 0 && category.amount >= priorAmount * 1.15 && category.amount - priorAmount >= 10000) {
      const increase = Math.round(((category.amount - priorAmount) / priorAmount) * 100);
      insights.push({
        type: 'category_increase',
        category: category.name,
        previousAmount: priorAmount,
        amount: category.amount,
        increasePercent: increase,
        message: `${category.name} 지출이 지난달보다 ${increase}% 늘었습니다.`
      });
    }
  }

  const netSavings = current.income - current.expenses;
  return {
    month,
    totals: {
      income: current.income,
      expenses: current.expenses,
      netSavings,
      savingsRate: current.income ? Math.round((netSavings / current.income) * 1000) / 10 : null,
      transactionCount: current.transactionCount,
      previousIncome: previous.income,
      previousExpenses: previous.expenses,
      previousNetSavings: previous.income - previous.expenses
    },
    categories: categoryRows,
    trends,
    topMerchants,
    recurring,
    insights,
    latestImport: latestImport || null
  };
}

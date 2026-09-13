import { getBudgetStatusFor, itemsRunningLow, listUpcomingTasks } from "./store.js";

/**
 * Smart meal planner: the one genuinely new *cross-tool* orchestration in
 * this round. It doesn't introduce a new data domain of its own — it reads
 * three things the store already tracks (low-stock shopping items, the
 * "groceries" budget's remaining amount, and upcoming tasks) and combines
 * them into a plan no single existing tool could produce:
 *   - low-stock items bias meal selection toward using up what's already
 *     nearly gone, instead of suggesting something that needs a totally
 *     separate grocery run;
 *   - the remaining weekly groceries budget caps total estimated cost across
 *     the plan, preferring cheaper meals once the budget is tight;
 *   - a day with an upcoming task due on it counts as "busy" and is biased
 *     toward a quick meal instead of something that takes an hour to cook.
 */

export interface MealCatalogEntry {
  name: string;
  ingredientKeywords: string[];
  estCost: number;
  quick: boolean;
}

// A small built-in catalog rather than a live recipe API — this is a
// self-hosted demo server with no external dependencies by design (see
// README's "no bundled model key" philosophy for generate_weekly_narrative).
// Matching is keyword-based against shopping-item names, so a household's
// own item names ("chicken thighs", "canned beans") still match generic
// keywords ("chicken", "beans") via substring comparison.
export const MEAL_CATALOG: MealCatalogEntry[] = [
  { name: "Chicken stir-fry", ingredientKeywords: ["chicken", "rice", "vegetable", "soy sauce"], estCost: 12, quick: true },
  { name: "Spaghetti with tomato sauce", ingredientKeywords: ["pasta", "tomato", "cheese"], estCost: 9, quick: true },
  { name: "Bean and rice burritos", ingredientKeywords: ["bean", "rice", "tortilla", "cheese"], estCost: 8, quick: true },
  { name: "Grilled cheese and soup", ingredientKeywords: ["bread", "cheese", "soup"], estCost: 6, quick: true },
  { name: "Egg fried rice", ingredientKeywords: ["egg", "rice", "vegetable"], estCost: 7, quick: true },
  { name: "Baked chicken with roasted vegetables", ingredientKeywords: ["chicken", "vegetable", "potato"], estCost: 14, quick: false },
  { name: "Slow-cooker beef stew", ingredientKeywords: ["beef", "potato", "carrot"], estCost: 15, quick: false },
  { name: "Pancakes for dinner", ingredientKeywords: ["egg", "milk", "flour"], estCost: 5, quick: true },
  { name: "Vegetable pasta bake", ingredientKeywords: ["pasta", "vegetable", "cheese"], estCost: 10, quick: false },
  // A cheap, ingredient-agnostic fallback for when nothing else matches or
  // the budget is too tight for anything fancier.
  { name: "Fridge-clearout stir-fry (whatever's on hand)", ingredientKeywords: [], estCost: 4, quick: true },
];

function matchesLowStockItem(keyword: string, itemNames: string[]): boolean {
  return itemNames.some((name) => name.includes(keyword) || keyword.includes(name));
}

export interface DayMealPlan {
  date: string;
  meal: string;
  quickMeal: boolean;
  busyDay: boolean;
  estCost: number;
  usesLowStockItems: string[];
}

export interface MealPlan {
  days: DayMealPlan[];
  totalEstCost: number;
  groceryBudgetRemaining: number | null;
  withinBudget: boolean;
  lowStockConsidered: string[];
  busyDayCount: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds an N-day meal plan for `householdId`. Pure planning logic over data
 * already read from the store (no writes) — the tool layer (tools/mealPlan.ts)
 * is what's responsible for turning this into an MCP response.
 */
export function buildMealPlan(householdId: string, days: number): MealPlan {
  const lowStockItems = itemsRunningLow(householdId).map((i) => i.name.toLowerCase());
  const groceryBudget = getBudgetStatusFor(householdId, "groceries");
  const groceryBudgetRemaining = groceryBudget ? groceryBudget.remaining : null;

  // A day counts as "busy" if any task is due on it — busy days bias toward
  // a quick meal instead of something that takes real hands-on time.
  const upcoming = listUpcomingTasks(householdId, days);
  const busyDates = new Set(upcoming.map((t) => t.dueDate));

  const used = new Set<string>(); // avoid repeating the same meal within one plan when a variety exists
  let runningCost = 0;
  const planDays: DayMealPlan[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = isoDate(date);
    const busyDay = busyDates.has(dateStr);

    // Score every unused candidate (falling back to every candidate once
    // they've all been used) by how many low-stock ingredients it uses, then
    // prefer a quick meal on a busy day, then prefer a cheaper meal so the
    // remaining budget stretches further.
    const pool = MEAL_CATALOG.filter((m) => !used.has(m.name));
    const candidates = pool.length > 0 ? pool : MEAL_CATALOG;

    const scored = candidates
      .map((meal) => {
        const usesLowStockItems = meal.ingredientKeywords.filter((kw) => matchesLowStockItem(kw, lowStockItems));
        return { meal, usesLowStockItems };
      })
      .sort((a, b) => {
        if (busyDay && a.meal.quick !== b.meal.quick) return a.meal.quick ? -1 : 1;
        if (b.usesLowStockItems.length !== a.usesLowStockItems.length) {
          return b.usesLowStockItems.length - a.usesLowStockItems.length;
        }
        return a.meal.estCost - b.meal.estCost;
      });

    // Respect the remaining grocery budget when one is set: prefer the
    // highest-scored candidate that still fits what's left, falling back to
    // the cheapest candidate overall (never leaving a day unplanned) if even
    // that doesn't fit.
    let choice = scored[0];
    if (groceryBudgetRemaining !== null) {
      const affordable = scored.find((c) => runningCost + c.meal.estCost <= groceryBudgetRemaining);
      choice = affordable ?? [...scored].sort((a, b) => a.meal.estCost - b.meal.estCost)[0];
    }

    used.add(choice.meal.name);
    runningCost += choice.meal.estCost;
    planDays.push({
      date: dateStr,
      meal: choice.meal.name,
      quickMeal: choice.meal.quick,
      busyDay,
      estCost: choice.meal.estCost,
      usesLowStockItems: choice.usesLowStockItems,
    });
  }

  return {
    days: planDays,
    totalEstCost: Math.round(runningCost * 100) / 100,
    groceryBudgetRemaining,
    withinBudget: groceryBudgetRemaining === null || runningCost <= groceryBudgetRemaining,
    lowStockConsidered: [...new Set(lowStockItems)],
    busyDayCount: planDays.filter((d) => d.busyDay).length,
  };
}

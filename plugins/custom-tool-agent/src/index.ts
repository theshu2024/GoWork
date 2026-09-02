/**
 * custom-tool-agent 示例插件
 *
 * 演示如何通过 registerAgentTool 向宿主的 Agent Loop 注册工具：
 * - calculator：安全数学表达式计算器（+ - * / ^ % 与括号）
 * - sales_summary：对数值/销售记录做汇总统计
 */
import type {
  HostContext,
  IDesktopPlugin,
} from './sdk';

/** 递归下降的安全算术求值器（不使用 eval） */
function evalMathExpression(expression: string): number {
  const s = expression.replace(/\s+/g, '');
  let i = 0;

  function parseExpr(): number {
    let v = parseTerm();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parsePow();
    while (s[i] === '*' || s[i] === '/' || s[i] === '%') {
      const op = s[i++];
      const r = parsePow();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function parsePow(): number {
    const base = parseAtom();
    if (s[i] === '^') {
      i++;
      const exp = parsePow(); // 右结合
      return Math.pow(base, exp);
    }
    return base;
  }
  function parseAtom(): number {
    if (s[i] === '(') {
      i++;
      const v = parseExpr();
      if (s[i] !== ')') throw new Error('缺少右括号 )');
      i++;
      return v;
    }
    let num = '';
    while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
    if (num === '') throw new Error(`无法解析表达式，位置 ${i} 附近: "${s.slice(i)}"`);
    return parseFloat(num);
  }

  const value = parseExpr();
  if (i < s.length) throw new Error(`意外字符: "${s[i]}"`);
  if (!Number.isFinite(value)) throw new Error('计算结果无效（可能除以 0）');
  return value;
}

export default class CustomToolAgentPlugin implements IDesktopPlugin {
  async onActivate(context: HostContext): Promise<void> {
    context.registerAgentTool({
      name: 'calculator',
      description:
        '数学表达式计算器。当用户需要进行算术计算（加减乘除、百分比、乘方、括号运算）时使用。不要自行心算，所有精确数值计算都应调用本工具。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '数学表达式，例如 "(1200+350)*0.8" 或 "1500*0.85+200"',
          },
        },
        required: ['expression'],
      },
      execute: async (args: { expression: string }) => {
        const expr = String(args?.expression ?? '');
        const result = evalMathExpression(expr);
        return { expression: expr, result };
      },
    });

    context.registerAgentTool({
      name: 'sales_summary',
      description:
        '对销售记录或数值数组进行汇总统计（求和、平均、最大、最小、计数）。当用户要求统计销售额、计算总和/平均值/Top 值时使用。',
      parameters: {
        type: 'object',
        properties: {
          records: {
            type: 'array',
            description:
              '记录数组：可以是纯数字数组 [100, 200]，也可以是对象数组 [{"product":"A","amount":100}]',
            items: {
              anyOf: [
                { type: 'number' },
                { type: 'object' },
              ],
            },
          },
          field: {
            type: 'string',
            description: '对象数组时，要统计的数值字段名，如 "amount" / "sales"',
          },
          operation: {
            type: 'string',
            enum: ['sum', 'avg', 'max', 'min', 'count', 'all'],
            description: '统计方式，默认 all（返回全部指标）',
          },
        },
        required: ['records'],
      },
      execute: async (args: {
        records: any[];
        field?: string;
        operation?: string;
      }) => {
        const records = Array.isArray(args?.records) ? args.records : [];
        const numbers: number[] = records
          .map((r) => {
            if (typeof r === 'number') return r;
            if (typeof r === 'string' && !isNaN(Number(r))) return Number(r);
            if (r && typeof r === 'object' && args.field) return Number(r[args.field]);
            return NaN;
          })
          .filter((n) => !isNaN(n));

        if (numbers.length === 0) {
          return {
            error:
              '未能从 records 中提取到数值。若为对象数组，请提供正确的 field 参数。',
          };
        }

        const sum = numbers.reduce((a, b) => a + b, 0);
        const stats: Record<string, number> = {
          count: numbers.length,
          sum: round(sum),
          avg: round(sum / numbers.length),
          max: round(Math.max(...numbers)),
          min: round(Math.min(...numbers)),
        };

        const op = args.operation || 'all';
        return {
          field: args.field || '(value)',
          operation: op,
          stats:
            op === 'all'
              ? stats
              : { [op]: stats[op as keyof typeof stats] },
        };
      },
    });

    context.logger.info(
      'custom-tool-agent 插件已激活：注册工具 calculator、sales_summary'
    );
  }

  async onDeactivate(): Promise<void> {}
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

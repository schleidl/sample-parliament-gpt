// Prepaid-credit ledger in the sessions DynamoDB table (see docs/billing.md).
//
//   pk = USER#<sub>   sk = CREDIT               balance (micros), createdAt, updatedAt
//   pk = USER#<sub>   sk = PAYMENT#<checkoutId> amountMicros, currency, createdAt (no TTL)
//
// Every balance change is a single conditional/atomic DynamoDB update, so concurrent
// requests (two tabs, a webhook racing a question) can never overspend or double-credit.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.SESSIONS_TABLE ?? "";
const REGION = process.env.AWS_REGION ?? "eu-central-1";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const pkOf = (sub: string) => `USER#${sub}`;
const CREDIT_SK = "CREDIT";

export function ledgerConfigured(): boolean {
  return Boolean(TABLE);
}

function isConditionFailure(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "ConditionalCheckFailedException" || name === "TransactionCanceledException";
}

async function readBalance(sub: string): Promise<number | null> {
  const out = await doc.send(
    new GetCommand({
      TableName: TABLE,
      Key: { pk: pkOf(sub), sk: CREDIT_SK },
      ConsistentRead: true,
    }),
  );
  if (!out.Item) return null;
  const b = out.Item.balance;
  return typeof b === "number" ? b : 0;
}

/**
 * Current balance in micros. The first read for an account creates its credit record
 * with the one-time free credit; the conditional put makes that grant happen exactly once
 * even under concurrent first requests.
 */
export async function getBalance(sub: string, freeCreditMicros: number): Promise<number> {
  const existing = await readBalance(sub);
  if (existing !== null) return existing;
  const now = new Date().toISOString();
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: pkOf(sub),
          sk: CREDIT_SK,
          balance: freeCreditMicros,
          freeCreditMicros,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return freeCreditMicros;
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
    return (await readBalance(sub)) ?? 0;
  }
}

/**
 * Reserve up to `holdMicros` for one question. Returns the amount actually reserved, or
 * null when the balance is below `minMicros`. A balance between min and hold is reserved
 * in full, so the last few cents stay usable.
 */
export async function reserve(
  sub: string,
  holdMicros: number,
  minMicros: number,
  freeCreditMicros: number,
): Promise<number | null> {
  // Two attempts: the second covers a balance that changed between read and write.
  for (let attempt = 0; attempt < 2; attempt++) {
    const balance = await getBalance(sub, freeCreditMicros);
    if (balance < Math.max(1, minMicros)) return null;
    const amount = Math.min(holdMicros, balance);
    try {
      await doc.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: pkOf(sub), sk: CREDIT_SK },
          UpdateExpression: "SET balance = balance - :a, updatedAt = :now",
          ConditionExpression: "balance >= :a",
          ExpressionAttributeValues: { ":a": amount, ":now": new Date().toISOString() },
        }),
      );
      return amount;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }
  return null;
}

/** Return the unused part of a reservation. Returns the new balance. */
export async function settle(sub: string, reservedMicros: number, chargedMicros: number): Promise<number> {
  const refund = Math.max(0, reservedMicros - Math.min(chargedMicros, reservedMicros));
  const out = await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: pkOf(sub), sk: CREDIT_SK },
      UpdateExpression: "ADD balance :r SET updatedAt = :now",
      ExpressionAttributeValues: { ":r": refund, ":now": new Date().toISOString() },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  const b = out.Attributes?.balance;
  return typeof b === "number" ? b : 0;
}

/**
 * Credit a completed payment exactly once. The PAYMENT record and the balance increment
 * commit in one transaction; a replayed webhook fails the record's existence condition
 * and changes nothing. Returns false for a duplicate.
 */
export async function creditPayment(
  sub: string,
  paymentId: string,
  amountMicros: number,
  currency: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              Item: {
                pk: pkOf(sub),
                sk: `PAYMENT#${paymentId}`,
                amountMicros,
                currency,
                createdAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            // ADD creates the record when the user pays before ever reading a balance
            // (that account then simply never receives the free credit).
            Update: {
              TableName: TABLE,
              Key: { pk: pkOf(sub), sk: CREDIT_SK },
              UpdateExpression: "ADD balance :a SET updatedAt = :now",
              ExpressionAttributeValues: { ":a": amountMicros, ":now": now },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

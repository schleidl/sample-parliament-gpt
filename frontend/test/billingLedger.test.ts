// Ledger against a mocked DynamoDB DocumentClient: the conditions are what keep money safe.

export {};

const sendMock = jest.fn();
jest.mock("@aws-sdk/lib-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/lib-dynamodb");
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: sendMock }) } };
});

const OLD = process.env;
async function loadLedger() {
  jest.resetModules();
  sendMock.mockReset();
  process.env = { ...OLD, SESSIONS_TABLE: "T", AWS_REGION: "eu-central-1" };
  return import("@/lib/billing/ledger");
}
afterAll(() => {
  process.env = OLD;
});

const conditionFailed = () => Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
const cmd = (i: number) => sendMock.mock.calls[i][0].input;

describe("getBalance", () => {
  test("existing record: returned as is, strongly consistent", async () => {
    const { getBalance } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Item: { balance: 1234 } });
    expect(await getBalance("u1", 500_000)).toBe(1234);
    expect(cmd(0)).toMatchObject({ Key: { pk: "USER#u1", sk: "CREDIT" }, ConsistentRead: true });
  });

  test("first read grants the free credit with a create-only condition", async () => {
    const { getBalance } = await loadLedger();
    sendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    expect(await getBalance("u1", 500_000)).toBe(500_000);
    expect(cmd(1).ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(cmd(1).Item.balance).toBe(500_000);
  });

  test("racing first reads: the loser re-reads instead of granting twice", async () => {
    const { getBalance } = await loadLedger();
    sendMock
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { balance: 300_000 } });
    expect(await getBalance("u1", 500_000)).toBe(300_000);
  });
});

describe("reserve", () => {
  test("reserves the full hold with a no-overdraft condition", async () => {
    const { reserve } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Item: { balance: 5_000_000 } }).mockResolvedValueOnce({});
    expect(await reserve("u1", 1_000_000, 20_000, 0)).toBe(1_000_000);
    expect(cmd(1).ConditionExpression).toBe("balance >= :a");
    expect(cmd(1).ExpressionAttributeValues[":a"]).toBe(1_000_000);
  });

  test("a balance below the hold is reserved in full", async () => {
    const { reserve } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Item: { balance: 300_000 } }).mockResolvedValueOnce({});
    expect(await reserve("u1", 1_000_000, 20_000, 0)).toBe(300_000);
  });

  test("below the minimum charge: refused without a write", async () => {
    const { reserve } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Item: { balance: 19_999 } });
    expect(await reserve("u1", 1_000_000, 20_000, 0)).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test("concurrent spend between read and write: retries, then refuses", async () => {
    const { reserve } = await loadLedger();
    sendMock
      .mockResolvedValueOnce({ Item: { balance: 1_000_000 } })
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { balance: 0 } });
    expect(await reserve("u1", 1_000_000, 20_000, 0)).toBeNull();
  });
});

describe("settle", () => {
  test("refunds the unused part of the reservation", async () => {
    const { settle } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Attributes: { balance: 4_910_000 } });
    expect(await settle("u1", 1_000_000, 90_000)).toBe(4_910_000);
    expect(cmd(0).ExpressionAttributeValues[":r"]).toBe(910_000);
  });

  test("a charge above the reservation refunds nothing (and never goes negative)", async () => {
    const { settle } = await loadLedger();
    sendMock.mockResolvedValueOnce({ Attributes: { balance: 0 } });
    await settle("u1", 100, 5000);
    expect(cmd(0).ExpressionAttributeValues[":r"]).toBe(0);
  });
});

describe("creditPayment", () => {
  test("payment record + balance increment commit together", async () => {
    const { creditPayment } = await loadLedger();
    sendMock.mockResolvedValueOnce({});
    expect(await creditPayment("u1", "cs_1", 5_000_000, "eur")).toBe(true);
    const [put, update] = cmd(0).TransactItems;
    expect(put.Put.Item.sk).toBe("PAYMENT#cs_1");
    expect(put.Put.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(update.Update.ExpressionAttributeValues[":a"]).toBe(5_000_000);
  });

  test("a replayed payment is a no-op", async () => {
    const { creditPayment } = await loadLedger();
    sendMock.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "TransactionCanceledException" }));
    expect(await creditPayment("u1", "cs_1", 5_000_000, "eur")).toBe(false);
  });

  test("other DynamoDB errors propagate (so Stripe retries)", async () => {
    const { creditPayment } = await loadLedger();
    sendMock.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" }));
    await expect(creditPayment("u1", "cs_1", 1, "eur")).rejects.toThrow();
  });
});

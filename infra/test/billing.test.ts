import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { FrontendStack, type FrontendStackProps } from "../lib/frontend-stack";

const env = { account: "111111111111", region: "eu-central-1" };

function synth(extra: Partial<FrontendStackProps>): Template {
  const app = new App();
  const net = new Stack(app, "Net", { env });
  const vpc = new ec2.Vpc(net, "Vpc", { natGateways: 0 });
  const stack = new FrontendStack(app, "Fe", {
    env,
    vpc,
    agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-central-1:111111111111:runtime/x",
    suffix: "t",
    ...extra,
  });
  return Template.fromStack(stack);
}

function webEnv(t: Template): Record<string, unknown> {
  const [td] = Object.values(t.findResources("AWS::ECS::TaskDefinition")) as any[];
  const c = td.Properties.ContainerDefinitions[0];
  return Object.fromEntries((c.Environment ?? []).map((e: any) => [e.Name, e.Value]));
}

describe("prepaid credits (billing)", () => {
  const off = synth({});
  const on = synth({
    billing: { currency: "eur", holdCents: 80, topupAmountsCents: [500, 1000], automaticTax: true },
  });

  test("off by default: no Stripe secret, no BILLING_* env (upstream behaviour)", () => {
    off.resourcePropertiesCountIs(
      "AWS::SecretsManager::Secret",
      { Name: Match.stringLikeRegexp("stripe") },
      0,
    );
    expect(Object.keys(webEnv(off)).filter((k) => k.startsWith("BILLING_"))).toEqual([]);
  });

  test("on: empty, retained, suffixed Stripe secret", () => {
    on.hasResource("AWS::SecretsManager::Secret", {
      Properties: { Name: "parlamentgpt/stripe-t", SecretString: Match.absent() },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("on: keys are read at runtime, never injected as ECS secrets (unfilled secret must not block task start)", () => {
    const [td] = Object.values(on.findResources("AWS::ECS::TaskDefinition")) as any[];
    const secrets = (td.Properties.ContainerDefinitions[0].Secrets ?? []).map((s: any) => s.Name);
    expect(secrets).toEqual(["COGNITO_CLIENT_SECRET"]);
  });

  test("on: billing env vars reach the container", () => {
    const e = webEnv(on);
    expect(e).toMatchObject({
      BILLING_ENABLED: "true",
      BILLING_CURRENCY: "eur",
      BILLING_HOLD_CENTS: "80",
      BILLING_TOPUP_AMOUNTS_CENTS: "500,1000",
      BILLING_AUTOMATIC_TAX: "true",
    });
    expect(e.BILLING_SECRET_ARN).toBeDefined();
    // Unset knobs are omitted so the app defaults apply.
    expect(e.BILLING_FREE_CREDIT_CENTS).toBeUndefined();
  });

  test("on: the task role may read the Stripe secret (and only via GetSecretValue-style actions)", () => {
    const policies = on.findResources("AWS::IAM::Policy");
    const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const read = statements.find(
      (s: any) => JSON.stringify(s.Resource ?? "").includes("StripeSecret"),
    );
    expect(read).toBeDefined();
    const actions = [].concat(read.Action);
    expect(actions).toContain("secretsmanager:GetSecretValue");
    expect(actions.some((a: string) => /Put|Update|Delete/.test(a))).toBe(false);
  });

  test("on: webhook URL output is published for the Stripe dashboard", () => {
    on.hasOutput("StripeWebhookUrl", {});
  });
});

"use strict";
// Cognito PreSignUp trigger: reject sign-ups outside ALLOWED_EMAIL_DOMAINS before any
// account or verification mail exists. Throwing surfaces as UserLambdaValidationException.
const { emailDomainAllowed } = require("./matcher");

exports.handler = async (event) => {
  const email = event?.request?.userAttributes?.email ?? "";
  if (!emailDomainAllowed(email, process.env.ALLOWED_EMAIL_DOMAINS)) {
    throw new Error("Sign-up is not available for this e-mail domain.");
  }
  return event;
};

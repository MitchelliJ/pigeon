/*
 * Compile-time contract for the Feature 16 account-management API client.
 */
import type {
  CancelAccountDeletionResult,
  ChangePasswordInput,
  ConfirmEmailChangeInput,
  ProfileSettings,
  RequestAccountDeletionInput,
  RequestAccountDeletionResult,
  RequestEmailChangeInput,
} from "@pigeon/shared";
import { privacy, profile } from "./api";

type Assert<T extends true> = T;
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type ExpectedFeature16Api = {
  profile: {
    get: () => Promise<ProfileSettings>;
    update: (patch: { name?: string }) => Promise<ProfileSettings>;
    changePassword: (input: ChangePasswordInput) => Promise<{ ok: true }>;
    requestEmailChange: (
      input: RequestEmailChangeInput,
    ) => Promise<{ ok: true }>;
    confirmEmailChange: (
      input: ConfirmEmailChangeInput,
    ) => Promise<ProfileSettings>;
  };
  privacy: {
    erase: (
      input: RequestAccountDeletionInput,
    ) => Promise<RequestAccountDeletionResult>;
    cancelErase: () => Promise<CancelAccountDeletionResult>;
  };
};

export type _Feature16ApiUsesTheSharedAccountManagementContract = Assert<
  IsEqual<
    { profile: typeof profile; privacy: typeof privacy },
    ExpectedFeature16Api
  >
>;

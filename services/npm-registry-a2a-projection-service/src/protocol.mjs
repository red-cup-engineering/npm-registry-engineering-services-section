import { createRelationalOperationProtocol } from "@red-cup-engineering/a2a-sovereign-operation-boundary-service";

export const registrySnapshotProtocol = createRelationalOperationProtocol({
  requestKind: "package-registry-snapshot.a2a-request.v1",
  responseKind: "package-registry-snapshot.a2a-response.v1",
  label: "Package registry snapshot",
});

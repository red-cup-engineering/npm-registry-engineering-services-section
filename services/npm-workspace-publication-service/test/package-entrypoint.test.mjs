import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanWorkspaceManifests} from '../src/read-workspace-manifests.mjs';
import {planReleaseWave, assertHousePublicationVersion} from '../src/release-wave.mjs';
import {planPackageVersionReset, applyPackageVersionResetWorkspace} from '../src/reset-package-versions.mjs';
import {rewriteVersionReference} from '../src/zero-major-version-reset.mjs';
test('the shared version operations preserve the workspace API',()=>{
 const published={scanWorkspaceManifests,planReleaseWave,assertHousePublicationVersion,planPackageVersionReset,applyPackageVersionResetWorkspace,rewriteVersionReference};
 for(const name of ['scanWorkspaceManifests','planReleaseWave','assertHousePublicationVersion','planPackageVersionReset','applyPackageVersionResetWorkspace','rewriteVersionReference'])assert.equal(typeof published[name],'function',name);
});

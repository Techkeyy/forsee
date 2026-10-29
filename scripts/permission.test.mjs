import {test} from 'node:test';
import assert from 'node:assert/strict';
import {permissionLabel,pendingLabel} from '../src/permission-state.js';
test('unknown permission and unavailable pending list never render as absent',()=>{
 assert.equal(permissionLabel(null),'unknown');assert.equal(permissionLabel(undefined),'unknown');assert.equal(permissionLabel(false),'not present');assert.equal(permissionLabel(true),'present');assert.equal(pendingLabel(null),'unavailable');assert.match(pendingLabel([]),/0 \(first 100 only/);
});

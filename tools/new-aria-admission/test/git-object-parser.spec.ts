import { parseVerifiedGitCommit } from '../src/adapters/git/git-commit-object';
import type { VerifiedGitObject } from '../src/adapters/git/git-raw-object';
import { snapshotVerifiedGitTree } from '../src/adapters/git/git-tree-object';

const oid = (digit: string): string => digit.repeat(40);
const numberedOid = (value: number): string => value.toString(16).padStart(40, '0');

function object(type: VerifiedGitObject['type'], id: string, bytes: Buffer): VerifiedGitObject {
  return Object.freeze({ oid: id, type, bytes });
}

describe('raw Git object grammar', () => {
  it('accepts a canonical multiline Git signature header after the identity pair', () => {
    const bytes = Buffer.from(
      `tree ${oid('1')}\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n Zm9v\n -----END SSH SIGNATURE-----\n\nmessage\n`,
    );

    expect(parseVerifiedGitCommit(object('commit', oid('3'), bytes))).toEqual({
      tree_oid: oid('1'),
      parent_oids: [],
    });
  });

  it('rejects a parent header introduced after the author header', () => {
    const bytes = Buffer.from(
      `tree ${oid('1')}\nauthor A <a@example.invalid> 1 +0000\nparent ${oid('2')}\ncommitter A <a@example.invalid> 1 +0000\n\nmessage\n`,
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('3'), bytes))).toThrow(/header order/);
  });

  it('rejects duplicate author metadata in a raw commit', () => {
    const bytes = Buffer.from(
      `tree ${oid('1')}\nauthor A <a@example.invalid> 1 +0000\nauthor B <b@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nmessage\n`,
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('3'), bytes))).toThrow(
      /author or committer/,
    );
  });

  it('rejects a noncanonical raw author identity', () => {
    const bytes = Buffer.from(
      `tree ${oid('1')}\nauthor A 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nmessage\n`,
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('3'), bytes))).toThrow(
      /author or committer/,
    );
  });

  it('rejects extension headers inserted before the canonical author and committer pair', () => {
    const bytes = Buffer.from(
      `tree ${oid('1')}\nencoding UTF-8\nauthor A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\nmessage\n`,
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('3'), bytes))).toThrow(/header order/);
  });

  it('rejects an octopus commit above the bounded parent roster before traversal', () => {
    const parents = Array.from(
      { length: 257 },
      (_, index) => `parent ${numberedOid(index + 1)}`,
    ).join('\n');
    const bytes = Buffer.from(
      `tree ${oid('f')}\n${parents}\nauthor A <a@example.invalid> 1 +0000\n` +
        'committer A <a@example.invalid> 1 +0000\n\nmessage\n',
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('e'), bytes))).toThrow(
      /parent count limit/,
    );
  });

  it('accepts the explicit octopus-parent boundary with unique identities', () => {
    const parentOids = Array.from({ length: 256 }, (_, index) => numberedOid(index + 1));
    const bytes = Buffer.from(
      `tree ${oid('f')}\n${parentOids.map((parent) => `parent ${parent}`).join('\n')}\n` +
        'author A <a@example.invalid> 1 +0000\n' +
        'committer A <a@example.invalid> 1 +0000\n\nmessage\n',
    );

    expect(parseVerifiedGitCommit(object('commit', oid('e'), bytes)).parent_oids).toEqual(
      parentOids,
    );
  });

  it('continues to reject a duplicated parent within the bounded roster', () => {
    const parent = numberedOid(1);
    const bytes = Buffer.from(
      `tree ${oid('f')}\nparent ${parent}\nparent ${parent}\n` +
        'author A <a@example.invalid> 1 +0000\n' +
        'committer A <a@example.invalid> 1 +0000\n\nmessage\n',
    );

    expect(() => parseVerifiedGitCommit(object('commit', oid('e'), bytes))).toThrow(
      /repeats a parent/,
    );
  });

  it('rejects a symbolic-link mode from the raw tree bytes', () => {
    const rootOid = oid('4');
    const rawTree = Buffer.concat([Buffer.from('120000 link\0'), Buffer.alloc(20, 5)]);
    const objects = new Map([[rootOid, object('tree', rootOid, rawTree)]]);

    expect(() => snapshotVerifiedGitTree(objects, oid('6'), rootOid)).toThrow(/forbidden mode/);
  });

  it('rejects a tree mode whose referenced object is a blob', () => {
    const rootOid = oid('4');
    const childOid = oid('5');
    const rawTree = Buffer.concat([Buffer.from('40000 child\0'), Buffer.from(childOid, 'hex')]);
    const objects = new Map([
      [rootOid, object('tree', rootOid, rawTree)],
      [childOid, object('blob', childOid, Buffer.from('child'))],
    ]);

    expect(() => snapshotVerifiedGitTree(objects, oid('6'), rootOid)).toThrow(/mode and type/);
  });
});

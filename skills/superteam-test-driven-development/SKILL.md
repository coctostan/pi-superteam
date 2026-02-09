---
name: superteam-test-driven-development
description: Write failing tests before implementation code — RED, GREEN, REFACTOR
globs: "**/*.ts,**/*.tsx,**/*.js,**/*.jsx"
---

# Test-Driven Development (TDD)

## The Cycle

Every code change follows the RED → GREEN → REFACTOR cycle:

### 1. RED — Write a Failing Test
- Write a test that describes the desired behavior
- Run it — it MUST fail
- The failure message should describe what's missing
- If the test passes immediately, it's testing the wrong thing

### 2. GREEN — Write Minimal Implementation
- Write the MINIMUM code to make the test pass
- No extra features, no "while I'm here" additions
- No refactoring yet — just make it work
- Run the test — it MUST pass

### 3. REFACTOR — Clean Up
- Improve code quality without changing behavior
- ALL tests must still pass after refactoring
- Remove duplication, improve naming, simplify
- Run tests after every change

## Rules

1. **Never write implementation code without a failing test first**
2. **Write only enough test to fail** — one assertion at a time
3. **Write only enough code to pass** — resist the urge to over-engineer
4. **Run tests constantly** — after every change, not just at the end
5. **Tests are first-class code** — maintain them with the same care

## Test Quality Checklist

- [ ] Tests verify BEHAVIOR, not implementation details
- [ ] Each test has a clear, descriptive name
- [ ] Tests are independent — no shared mutable state
- [ ] Edge cases are covered: null, empty, boundary values
- [ ] Error cases are tested explicitly
- [ ] Tests run fast (< 1 second each)

## Anti-Patterns to Avoid

- ❌ Writing implementation first, then "adding tests"
- ❌ Writing multiple tests before any implementation
- ❌ Testing private methods or implementation details
- ❌ Excessive mocking — prefer real objects when possible
- ❌ "This is too simple to test" — it's not
- ❌ Copying implementation logic into test assertions

## Example Workflow

```
Feature: Add function to validate email

1. RED: Write test
   test("rejects empty string", () => {
     expect(validateEmail("")).toBe(false);
   });
   → Run → FAIL (validateEmail not defined)

2. GREEN: Implement minimally
   function validateEmail(email: string): boolean {
     return email.length > 0;
   }
   → Run → PASS

3. RED: Next test
   test("rejects string without @", () => {
     expect(validateEmail("foo")).toBe(false);
   });
   → Run → FAIL

4. GREEN: Extend implementation
   function validateEmail(email: string): boolean {
     return email.length > 0 && email.includes("@");
   }
   → Run → PASS

5. REFACTOR: (nothing to refactor yet)

6. Continue cycle for more cases...
```

## When TDD Guard is Active

The superteam extension enforces TDD mechanically:
- You cannot write to implementation files without a test file existing
- You cannot write to implementation files without tests having been run
- Test files are always writable
- Use `/tdd` to check mode, `/tdd off` to disable if needed

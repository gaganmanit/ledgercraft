import test from "node:test";
import assert from "node:assert/strict";
import { nextLineAction } from "../lib/voucher-entry.js";
const row=(debit="",credit="")=>({debit,credit});

test("one voucher action adds an empty line or fills the missing amount in the first free line",()=>{
  assert.deepEqual(nextLineAction([row(),row()]),{index:2,side:null,paise:0,label:"Add line"});
  assert.deepEqual(nextLineAction([row("1,200.01"),row()]),{index:1,side:"credit",paise:120001,label:"Fill credit ₹1,200.01"});
  assert.deepEqual(nextLineAction([row("2"),row("","7.42")]),{index:2,side:"debit",paise:542,label:"Add debit ₹5.42"});
  assert.equal(nextLineAction([row("1.01"),row("","1.01")]).label,"Add line");
  assert.throws(()=>nextLineAction([row("1","3")]),/either debit or credit/);
});

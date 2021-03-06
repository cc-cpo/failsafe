// Internal RPC serves requests made by the wallet (the user's browser) or by the merchant app

module.exports = async (ws, msg) => {
  var result = {}

  var json = parse(bin(msg).toString())

  // prevents all kinds of CSRF and DNS rebinding
  // strong coupling between the console and the browser client

  if (json.auth_code == PK.auth_code) {
    if (ws.send) {
      // browser session
      me.browser = ws
    }

    var p = json.params

    switch (json.method) {
      case 'sync':
        result.confirm = 'Syncing the chain...'
        sync()

        break
      case 'load':
        if (p.username) {
          var seed = await derive(p.username, p.pw)
          await me.init(p.username, seed)
          await me.start()

          result.confirm = 'Welcome!'
        }

        break
      case 'logout':
        me.intervals.map(clearInterval)

        if (me.member_server) {
          me.member_server.close()
          me.wss.clients.forEach(c => c.close())
          // Object.keys(me.users).forEach( c=>me.users[c].end() )
        }
        me = new Me()
        result.pubkey = null

        break

      case 'dispute':
        var ch = await me.channel(Members.find(m => m.id == p.partner).pubkey)
        await ch.d.startDispute(p.profitable)

        result.confirm = 'Started a Dispute'
        break

      case 'send':

        // TODO: support batch sends

        var amount = parseInt(p.amount)

        if (p.userId.length == 64) {
          var mediate_to = Buffer.from(p.userId, 'hex')
        } else {
          var mediate_to = await User.findById(parseInt(p.userId))
          if (mediate_to) {
            mediate_to = mediate_to.pubkey
          } else {
            result.alert = 'This user ID is not found'
            break
          }
        }

        var partner = Members.find(m => m.id == p.partner).pubkey

        var [status, error] = await me.payChannel({
          partner: partner,
          amount: amount,
          execution: p.execution,

          mediate_to: mediate_to,
          mediate_hub: Members.find(m => m.hub && (m.hub.handle == p.hubId)).id,

          return_to: (obj) => {
            ws.send ? ws.send(JSON.stringify({
              result: obj,
              id: json.id
            })) : ws.end(JSON.stringify(obj))
          },

          invoice: Buffer.from(p.invoice, 'hex')
        })

        if (error) {
          result.alert = error
        } else {
          result.confirm = 'Payment sent'
        }

        break

      case 'rebalance':
        l('contacting hubs and collecting instant withdrawals ins')

        var ins = []
        var outs = []

        for (o of p.outs) {
          // split by @
          if (o.to.length > 0) {
            var to = o.to.split('@')

            if (to[0].length == 64) {
              var userId = Buffer.from(to[0], 'hex')

              // maybe this pubkey is already registred?
              var u = await User.findOne({where: {
                pubkey: userId
              }})

              if (u) {
                userId = u.id
              }
            } else {
              var userId = parseInt(to[0])

              var u = await User.findById(userId)

              if (!u) {
                result.alert = 'User with short ID ' + userId + " doesn't exist."
                break
              }
            }

            if (o.amount.indexOf('.') == -1) o.amount += '.00'

            var amount = parseInt(o.amount.replace(/[^0-9]/g, ''))

            if (amount > 0) {
              outs.push([amount, 
                userId, 
                to[1] ? Members.find(m => m.hub && m.hub.handle == to[1]).id : 0
              ])
            }
          }
        }

        if (p.request_amount > 0) {
          var partner = Members.find(m => m.id == p.partner)
          var ch = await me.channel(partner.pubkey)
          if (p.request_amount > ch.insured) {
            react({alert: 'More than you can withdraw from insured'})
            break
          }
          me.send(partner, 'requestWithdraw', me.envelope(p.request_amount))

          // waiting for the response
          setTimeout(async () => {
            var ch = await me.channel(partner.pubkey)
            if (ch.d.our_input_sig) {
              ins.push([ ch.d.our_input_amount,
                ch.d.partnerId,
                ch.d.our_input_sig ])

              l("Rebalancing ", [ins, outs])

              await me.broadcast('rebalance', r([0, ins, outs]))
              react({confirm: 'On-chain rebalance tx sent'})
            } else {
              react({alert: 'Failed to obtain withdrawal. Try later or start a dispute.'})
            }
          }, 3000)
        } else if (outs.length > 0) {
          await me.broadcast('rebalance', r([0, ins, outs]))
          react({confirm: 'Rebalanced'})
        } else {
          react({alert: 'No action specified'})
        }

        return false

        break


      case 'testnet':
        me.send(Members.find(m => m.id == p.partner), 'testnet', concat(bin([p.action]), me.pubkey))

        result.confirm = 'Testnet action triggered'
        break

      case 'setLimits':
        var m = Members.find(m => m.id == p.partner)

        var ch = await me.channel(m.pubkey)

        ch.d.we_soft_limit = parseInt(p.limits[0]) * 100
        ch.d.we_hard_limit = parseInt(p.limits[1]) * 100
        await ch.d.save()

        me.send(m, 'setLimits', me.envelope(
            methodMap('setLimits'), ch.d.we_soft_limit, ch.d.we_hard_limit
        ))

        result.confirm = 'The hub has been notified about new credit limits'

        break

      // creates and checks status of invoice
      case 'invoice':
        if (p.invoice) {
          // deep clone
          var result = Object.assign({}, invoices[p.invoice])

          // prevent race condition attack
          if (invoices[p.invoice].status == 'paid') {
            invoices[p.invoice].status = 'archive'
          }
        } else if (p.amount) {
          var secret = crypto.randomBytes(32)
          var invoice = toHex(sha3(secret))

          invoices[invoice] = {
            secret: secret,
            amount: parseInt(p.amount),
            extra: p.extra,
            status: 'pending'
          }

          me.record = await me.byKey()

          l('invoice ',p)

          result.new_invoice = [
            invoices[invoice].amount,
            me.record ? me.record.id : toHex(me.pubkey),
            Members.find(m => m.id == p.partner).hub.handle,
            invoice].join('_')

          result.confirm = 'Invoice Created'
        }
        break

      case 'propose':
        result.confirm = await me.broadcast('propose', p)
        break

      case 'vote':
        result.confirm = await me.broadcast('vote', r([p.id, p.approval, p.rationale]))

        break

      // Successor of Secure Login, returns signed origin
      case 'login':
         ws.send(JSON.stringify({
            result: toHex(nacl.sign(Buffer.from(json.proxyOrigin), me.id.secretKey)),
            id: json.id
          }))
        return false
        break
    }

    // http or websocket?
    if (ws.end) {
      ws.end(JSON.stringify(result))
    } else {
      react(result, json.id)
    }
  } else {
    ws.send(JSON.stringify({
      result: cached_result,
      id: json.id
    }))
  }
}

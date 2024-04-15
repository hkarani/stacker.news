import { createContext, useCallback, useContext } from 'react'
import { useMe } from './me'
import { gql, useApolloClient, useMutation } from '@apollo/client'
import { useWebLN } from './webln'
import { FAST_POLL_INTERVAL } from '@/lib/constants'
import { INVOICE } from '@/fragments/wallet'
import { JITInvoice } from '@/components/invoice'
import { useShowModal } from './modal'
import { useFeeButton } from './fee-button'

const PaymentContext = createContext()

export class InvoiceCanceledError extends Error {
  constructor () {
    super('invoice canceled')
    this.name = 'InvoiceCanceledError'
  }
}

const checkInvoice = async ({ id, apolloClient }) => {
  const { data, error } = await apolloClient.query({ query: INVOICE, fetchPolicy: 'no-cache', variables: { id } })
  if (error) {
    throw error
  }
  const { isHeld, satsReceived, cancelled } = data
  // if we're polling for invoices, we're using JIT invoices so isHeld must be set
  if (isHeld && satsReceived) {
    return true
  }
  if (cancelled) {
    throw new InvoiceCanceledError()
  }
  return false
}

export const PaymentProvider = ({ children }) => {
  const me = useMe()
  const apolloClient = useApolloClient()
  const provider = useWebLN()
  const feeButton = useFeeButton()
  const showModal = useShowModal()
  const [createInvoice] = useMutation(gql`
    mutation createInvoice($amount: Int!) {
      createInvoice(amount: $amount, hodlInvoice: true, expireSecs: 180) {
        id
        bolt11
        hash
        hmac
        expiresAt
      }
    }`)
  const [cancelInvoice] = useMutation(gql`
    mutation cancelInvoice($hash: String!, $hmac: String!) {
      cancelInvoice(hash: $hash, hmac: $hmac) {
        id
      }
    }
  `)

  const waitForWebLnPayment = useCallback(async ({ id, bolt11 }) => {
    try {
      return await new Promise((resolve, reject) => {
        // can't use await here since we might pay JIT invoices and sendPaymentAsync is not supported yet.
        // see https://www.webln.guide/building-lightning-apps/webln-reference/webln.sendpaymentasync
        provider.sendPaymentV2(bolt11)
          // JIT invoice payments will never resolve here
          // since they only get resolved after settlement which can't happen here
          .then(() => resolve())
          .catch(err => {
            clearInterval(interval)
            reject(err)
          })
        const interval = setInterval(async () => {
          try {
            const paid = await checkInvoice({ id, apolloClient })
            if (paid) resolve()
          } catch (err) {
            clearInterval(interval)
            reject(err)
          }
        }, FAST_POLL_INTERVAL)
      })
    } catch (err) {
      console.error('WebLN payment failed:', err)
      throw err
    }
  }, [provider, apolloClient])

  const waitForQrPayment = useCallback(async (inv) => {
    return await new Promise((resolve, reject) => {
      let paid
      const cancelAndReject = async (onClose) => {
        if (paid) return
        await cancelInvoice({ variables: { hash: inv.hash, hmac: inv.hmac } })
        reject(new InvoiceCanceledError())
      }
      showModal(onClose => {
        return (
          <JITInvoice
            invoice={inv}
            onPayment={() => { paid = true; onClose(); resolve() }}
            onCancel={cancelAndReject}
          />
        )
      }, { keepOpen: true, onClose: cancelAndReject })
    })
  }, [showModal])

  const waitForPayment = useCallback(async (inv) => {
    if (provider.enabled) {
      try {
        return await waitForWebLnPayment(inv)
      } catch (err) {
        if (err instanceof InvoiceCanceledError) {
          // bail since qr code payment will also fail if invoice was canceled
          throw err
        }
      }
    }

    return waitForQrPayment(inv)
  }, [provider])

  const payment = useCallback(async () => {
    const amount = feeButton?.total
    const free = feeButton?.free

    // if user has enough funds in their wallet, never prompt for payment
    const insufficientFunds = me?.privates.sats < amount
    if (free || !insufficientFunds) return { hash: null, hmac: null }

    // create invoice
    const { data, error } = await createInvoice({ variables: { amount } })
    if (error) throw error
    const inv = data.createInvoice

    // wait for payment
    await waitForPayment(inv)

    // return paid invoice data
    return inv
  }, [me, feeButton?.total, createInvoice, waitForPayment])

  return (
    <PaymentContext.Provider value={payment}>
      {children}
    </PaymentContext.Provider>
  )
}

export const usePayment = () => {
  return useContext(PaymentContext)
}
